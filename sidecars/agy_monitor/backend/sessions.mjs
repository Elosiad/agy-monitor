import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const ONE_DAY_MS = 24 * 3600 * 1000;

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Brief spin only when SQLITE_BUSY happens on readOnly WAL open
  }
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 1e12 ? Math.trunc(raw) : Math.trunc(raw * 1000);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return 0;
}

export function extractWorkspaceLabel(rawUris) {
  if (!rawUris || typeof rawUris !== 'string') return '';
  let uriList = [];
  const trimmed = rawUris.trim();
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) uriList = arr.map(String);
    } catch {
      uriList = [trimmed];
    }
  } else {
    uriList = trimmed.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
  }

  for (const raw of uriList) {
    let cleaned = raw.replace(/^file:\/+/i, '');
    try {
      cleaned = decodeURIComponent(cleaned);
    } catch {
      // Keep raw if malformed URI encoding
    }
    cleaned = cleaned.replace(/[\\/]+$/, '');
    const parts = cleaned.split(/[\\/]+/).filter(Boolean);
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  }
  return '';
}

export function formatAgoText(modifiedMs, nowMs = Date.now()) {
  if (!modifiedMs || modifiedMs <= 0) return '';
  const diff = Math.max(0, nowMs - modifiedMs);
  const mins = Math.max(1, Math.floor(diff / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function openSummariesReadOnly(summariesDbPath) {
  if (!summariesDbPath || !fs.existsSync(summariesDbPath)) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return new DatabaseSync(summariesDbPath, { readOnly: true, timeout: 1500 });
    } catch (err) {
      if (err && String(err.message || '').includes('SQLITE_BUSY') && attempt < 2) {
        sleepSync(40 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

function mapRow(row, favoriteSet, nowMs) {
  const modifiedMs = parseTimestampMs(row.last_modified_time);
  const title =
    typeof row.title === 'string' && row.title.trim()
      ? row.title.trim()
      : typeof row.preview === 'string' && row.preview.trim()
        ? row.preview.trim().slice(0, 60)
        : row.conversation_id.slice(0, 8);
  const workspace = extractWorkspaceLabel(row.workspace_uris);
  let status = 'idle';
  if (row.status === 'CASCADE_RUN_STATUS_RUNNING') {
    status = 'running';
  } else if (Number(row.not_fully_idle) === 1) {
    status = 'waiting';
  }

  return {
    id: row.conversation_id,
    title,
    workspace,
    status,
    stepCount: Number(row.step_count || 0),
    modifiedMs,
    agoText: formatAgoText(modifiedMs, nowMs),
    isFavorite: favoriteSet.has(row.conversation_id),
  };
}

async function saveSessionsMetaCompat(storage, nextMeta) {
  if (!storage) return nextMeta;
  if (typeof storage.updateSessionsMeta === 'function') {
    return await storage.updateSessionsMeta(nextMeta);
  }
  if (typeof storage.saveSessionsMeta === 'function') {
    return await storage.saveSessionsMeta(nextMeta);
  }
  return nextMeta;
}

/**
 * Queries conversation_summaries.db strictly in read-only mode and aggregates sessions hub buckets.
 */
export async function querySessionsHub(summariesDbPath, storage, telemetryMeta = {}) {
  const nowMs = typeof telemetryMeta?.nowMs === 'number' ? telemetryMeta.nowMs : Date.now();
  const meta = (await storage?.getSessionsMeta?.()) || {};
  const favoriteIds = Array.isArray(meta.favoriteIds)
    ? [...new Set(meta.favoriteIds.map(String).filter(Boolean))]
    : [];
  const favoriteTitles =
    meta.favoriteTitles && typeof meta.favoriteTitles === 'object' ? meta.favoriteTitles : {};
  const favoriteSet = new Set(favoriteIds);
  const lastSeenByConv =
    meta.lastSeenByConv && typeof meta.lastSeenByConv === 'object' ? meta.lastSeenByConv : {};
  const initializedAtMs = Number(meta.initializedAtMs || 0);

  const resolveFavoriteFallbackTitle = (convId) => {
    const saved = typeof favoriteTitles[convId] === 'string' ? favoriteTitles[convId].trim() : '';
    return saved || convId.slice(0, 8);
  };

  const fallbackResult = () => ({
    active: [],
    waiting: [],
    unread: [],
    recent: [],
    favorites: favoriteIds.map((id) => ({
      id,
      title: resolveFavoriteFallbackTitle(id),
      workspace: '',
      modifiedMs: 0,
      agoText: '',
    })),
    allSelectable: [],
    subStatusById: {},
  });

  const db = openSummariesReadOnly(summariesDbPath);
  if (!db) {
    return fallbackResult();
  }

  try {
    const rawRows = db
      .prepare(
        `SELECT conversation_id, title, preview, step_count, last_modified_time,
                workspace_uris, status, not_fully_idle
         FROM conversation_summaries
         WHERE COALESCE(parent_conversation_id, '') = ''
           AND COALESCE(killed, 0) = 0
         ORDER BY last_modified_time DESC
         LIMIT 200`
      )
      .all();

    const subStatusById = {};
    try {
      const childRows = db
        .prepare(
          `SELECT conversation_id, parent_conversation_id, status, not_fully_idle,
                  killed, step_count, last_modified_time
           FROM conversation_summaries
           WHERE COALESCE(parent_conversation_id, '') != ''
              OR COALESCE(nesting_depth, 0) > 0
           ORDER BY last_modified_time DESC
           LIMIT 400`
        )
        .all();
      for (const r of childRows) {
        const cid = typeof r?.conversation_id === 'string' ? r.conversation_id.trim() : '';
        if (!cid) continue;
        subStatusById[cid] = {
          parentId: typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id.trim() : '',
          status: typeof r.status === 'string' ? r.status : '',
          notFullyIdle: Number(r.not_fully_idle || 0) === 1,
          killed: Number(r.killed || 0) === 1,
          stepCount: Number(r.step_count || 0),
          modifiedMs: parseTimestampMs(r.last_modified_time),
        };
      }
    } catch {
      // Optional child-row index on older/minimal test schemas lacking nesting_depth
    }

    const mapped = rawRows.map((r) => mapRow(r, favoriteSet, nowMs));
    const byId = new Map(mapped.map((m) => [m.id, m]));

    const active = mapped
      .filter((m) => m.status === 'running')
      .map(({ id, title, workspace, status, modifiedMs, isFavorite }) => ({
        id,
        title,
        workspace,
        status,
        modifiedMs,
        isFavorite,
      }));

    const waiting = mapped
      .filter((m) => m.status === 'waiting')
      .map(({ id, title, workspace, status, modifiedMs, agoText, isFavorite }) => ({
        id,
        title,
        workspace,
        status,
        modifiedMs,
        agoText,
        isFavorite,
      }));

    const unread = mapped
      .filter((m) => {
        if (m.status === 'running' || m.status === 'waiting' || m.stepCount <= 0) return false;
        const seenMs = lastSeenByConv[m.id];
        if (typeof seenMs === 'number' && seenMs > 0) {
          return m.modifiedMs > seenMs;
        }
        if (initializedAtMs > 0) {
          return m.modifiedMs > initializedAtMs;
        }
        return m.modifiedMs >= nowMs - ONE_DAY_MS;
      })
      .slice(0, 12)
      .map(({ id, title, workspace, status, modifiedMs, agoText, isFavorite }) => ({
        id,
        title,
        workspace,
        status,
        modifiedMs,
        agoText,
        isFavorite,
      }));

    const recent = mapped
      .slice(0, 12)
      .map(({ id, title, workspace, status, modifiedMs, agoText, isFavorite }) => ({
        id,
        title,
        workspace,
        status,
        modifiedMs,
        agoText,
        isFavorite,
      }));

    const favorites = [];
    for (const favId of favoriteIds) {
      let item = byId.get(favId);
      if (!item) {
        const extra = db
          .prepare(
            `SELECT conversation_id, title, preview, step_count, last_modified_time,
                    workspace_uris, status, not_fully_idle
             FROM conversation_summaries
             WHERE conversation_id = ?`
          )
          .get(favId);
        if (extra) {
          item = mapRow(extra, favoriteSet, nowMs);
        }
      }
      if (item) {
        const shortFallback = favId.slice(0, 8);
        const resolvedTitle =
          item.title && item.title !== shortFallback
            ? item.title
            : resolveFavoriteFallbackTitle(favId);
        favorites.push({
          id: item.id,
          title: resolvedTitle,
          workspace: item.workspace,
          status: item.status,
          modifiedMs: item.modifiedMs,
        });
      } else {
        favorites.push({
          id: favId,
          title: resolveFavoriteFallbackTitle(favId),
          workspace: '',
          modifiedMs: 0,
        });
      }
    }

    const allSelectable = mapped
      .slice(0, 100)
      .map(({ id, title, workspace, status, modifiedMs }) => ({
        id,
        title,
        workspace,
        status,
        modifiedMs,
      }));

    return {
      active,
      waiting,
      unread,
      recent,
      favorites,
      allSelectable,
      subStatusById,
    };
  } catch {
    return fallbackResult();
  } finally {
    try {
      db.close();
    } catch {
      // Ignore close error
    }
  }
}

export async function markRead(storage, { conversationId, modifiedMs } = {}) {
  const id = typeof conversationId === 'string' ? conversationId.trim() : '';
  if (!id) {
    throw new Error('conversationId is required');
  }

  let resolvedTs = Number(modifiedMs) || Date.now();
  const buildNext = (meta = {}) => {
    const existingMap = meta.lastSeenModifiedMs || meta.lastSeenByConv || {};
    const prevMap = existingMap && typeof existingMap === 'object' ? { ...existingMap } : {};
    const ts = Math.max(Number(prevMap[id] || 0), Number(modifiedMs) || Date.now());
    resolvedTs = ts;
    prevMap[id] = ts;
    const watermark = Number(meta.firstTrackWatermarkMs || meta.initializedAtMs || 0) || Date.now();
    return {
      ...meta,
      favoriteIds: Array.isArray(meta.favoriteIds) ? meta.favoriteIds : [],
      favoriteTitles:
        meta.favoriteTitles && typeof meta.favoriteTitles === 'object' ? { ...meta.favoriteTitles } : {},
      lastSeenModifiedMs: prevMap,
      lastSeenByConv: { ...prevMap },
      lastSeenByAgent:
        meta.lastSeenByAgent && typeof meta.lastSeenByAgent === 'object' ? { ...meta.lastSeenByAgent } : {},
      firstTrackWatermarkMs: watermark,
      initializedAtMs: watermark,
    };
  };

  if (typeof storage?.updateSessionsMeta === 'function') {
    await storage.updateSessionsMeta(buildNext);
  } else {
    const meta = (await storage?.getSessionsMeta?.()) || {};
    await saveSessionsMetaCompat(storage, buildNext(meta));
  }
  return { ok: true, conversationId: id, modifiedMs: resolvedTs };
}

export async function setFavorites(storage, { favoriteIds, favoriteTitles } = {}) {
  if (!Array.isArray(favoriteIds)) {
    throw new Error('favoriteIds must be an array');
  }
  const cleaned = [...new Set(favoriteIds.map((x) => String(x || '').trim()).filter(Boolean))];
  const buildNext = (meta = {}) => {
    const existingMap = meta.lastSeenModifiedMs || meta.lastSeenByConv || {};
    const watermark = Number(meta.firstTrackWatermarkMs || meta.initializedAtMs || 0) || Date.now();
    return {
      ...meta,
      favoriteIds: cleaned,
      favoriteTitles: {
        ...(meta.favoriteTitles && typeof meta.favoriteTitles === 'object' ? meta.favoriteTitles : {}),
        ...(favoriteTitles && typeof favoriteTitles === 'object' ? favoriteTitles : {}),
      },
      lastSeenModifiedMs: { ...existingMap },
      lastSeenByConv: { ...existingMap },
      lastSeenByAgent:
        meta.lastSeenByAgent && typeof meta.lastSeenByAgent === 'object' ? { ...meta.lastSeenByAgent } : {},
      firstTrackWatermarkMs: watermark,
      initializedAtMs: watermark,
    };
  };

  if (typeof storage?.updateSessionsMeta === 'function') {
    await storage.updateSessionsMeta(buildNext);
  } else {
    const meta = (await storage?.getSessionsMeta?.()) || {};
    await saveSessionsMetaCompat(storage, buildNext(meta));
  }
  return { ok: true, favoriteIds: cleaned };
}
