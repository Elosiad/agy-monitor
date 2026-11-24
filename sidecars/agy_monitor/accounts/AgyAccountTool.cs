using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace AgyAccountTool
{
    class Program
    {
        private static readonly byte[] DpapiEntropy = Encoding.UTF8.GetBytes("agy-monitor-account-vault-v1");
        private const int CRED_TYPE_GENERIC = 1;
        private const int CRED_PERSIST_LOCAL_MACHINE = 2;
        private const uint WM_CLOSE = 0x0010;

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredRead(string target, int type, int reservedFlag, out IntPtr credentialPtr);

        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredWrite(ref CREDENTIAL userCredential, uint flags);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDelete(string target, int type, int flags);

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern void CredFree(IntPtr credPointer);

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct CREDENTIAL
        {
            public uint Flags;
            public uint Type;
            public string TargetName;
            public string Comment;
            public long LastWritten;
            public uint CredentialBlobSize;
            public IntPtr CredentialBlob;
            public uint Persist;
            public uint AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll")]
        private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        static int Main(string[] args)
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);

            if (args == null || args.Length == 0)
            {
                WriteJson(new Dictionary<string, object> { { "ok", false }, { "error", "missing command" } });
                return 1;
            }

            string cmd = args[0];
            try
            {
                if (cmd == "--version")
                {
                    WriteJson(new Dictionary<string, object> { { "ok", true }, { "version", "1.0.0" } });
                    return 0;
                }
                if (cmd == "--cred-read")
                {
                    string target = args.Length > 1 ? args[1] : "gemini:antigravity";
                    return HandleCredRead(target);
                }
                if (cmd == "--cred-write")
                {
                    return HandleCredWrite();
                }
                if (cmd == "--cred-delete")
                {
                    string target = args.Length > 1 ? args[1] : "gemini:antigravity";
                    return HandleCredDelete(target);
                }
                if (cmd == "--dpapi-protect")
                {
                    return HandleDpapiProtect();
                }
                if (cmd == "--dpapi-unprotect")
                {
                    return HandleDpapiUnprotect();
                }
                if (cmd == "--switch-daemon")
                {
                    if (args.Length < 2 || string.IsNullOrEmpty(args[1]))
                    {
                        return 2;
                    }
                    return HandleSwitchDaemon(args[1]);
                }

                WriteJson(new Dictionary<string, object> { { "ok", false }, { "error", "unknown command: " + cmd } });
                return 1;
            }
            catch (Exception ex)
            {
                WriteJson(new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
                return 1;
            }
        }

        private static JavaScriptSerializer CreateSerializer()
        {
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 32 * 1024 * 1024;
            return ser;
        }

        private static void WriteJson(object obj)
        {
            Console.Write(CreateSerializer().Serialize(obj));
        }

        private static string ReadAllStdin()
        {
            using (StreamReader sr = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)))
            {
                return sr.ReadToEnd();
            }
        }

        private static Dictionary<string, object> ReadCredentialInternal(string preferredTarget)
        {
            List<string> candidates = new List<string>();
            if (!string.IsNullOrEmpty(preferredTarget))
            {
                candidates.Add(preferredTarget);
            }
            if (!candidates.Contains("gemini:antigravity"))
            {
                candidates.Add("gemini:antigravity");
            }
            if (!candidates.Contains("LegacyGeneric:target=gemini:antigravity"))
            {
                candidates.Add("LegacyGeneric:target=gemini:antigravity");
            }

            foreach (string target in candidates)
            {
                IntPtr ptr;
                if (CredRead(target, CRED_TYPE_GENERIC, 0, out ptr))
                {
                    try
                    {
                        CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
                        byte[] blob = new byte[cred.CredentialBlobSize];
                        if (cred.CredentialBlobSize > 0 && cred.CredentialBlob != IntPtr.Zero)
                        {
                            Marshal.Copy(cred.CredentialBlob, blob, 0, (int)cred.CredentialBlobSize);
                        }
                        string lastWrittenIso = "";
                        try
                        {
                            if (cred.LastWritten > 0)
                            {
                                lastWrittenIso = DateTime.FromFileTimeUtc(cred.LastWritten).ToString("o");
                            }
                        }
                        catch { }

                        return new Dictionary<string, object>
                        {
                            { "ok", true },
                            { "found", true },
                            { "target", cred.TargetName ?? target },
                            { "userName", cred.UserName ?? "antigravity" },
                            { "persist", (int)cred.Persist },
                            { "blobBase64", Convert.ToBase64String(blob) },
                            { "lastWrittenUtc", lastWrittenIso }
                        };
                    }
                    finally
                    {
                        CredFree(ptr);
                    }
                }
            }

            return new Dictionary<string, object>
            {
                { "ok", true },
                { "found", false },
                { "target", preferredTarget }
            };
        }

        private static bool WriteCredentialInternal(string target, string userName, int persist, byte[] blobBytes)
        {
            IntPtr blobPtr = IntPtr.Zero;
            try
            {
                if (blobBytes != null && blobBytes.Length > 0)
                {
                    blobPtr = Marshal.AllocHGlobal(blobBytes.Length);
                    Marshal.Copy(blobBytes, 0, blobPtr, blobBytes.Length);
                }

                CREDENTIAL cred = new CREDENTIAL();
                cred.Flags = 0;
                cred.Type = CRED_TYPE_GENERIC;
                cred.TargetName = string.IsNullOrEmpty(target) ? "gemini:antigravity" : target;
                cred.UserName = string.IsNullOrEmpty(userName) ? "antigravity" : userName;
                cred.CredentialBlobSize = blobBytes != null ? (uint)blobBytes.Length : 0u;
                cred.CredentialBlob = blobPtr;
                cred.Persist = persist > 0 ? (uint)persist : (uint)CRED_PERSIST_LOCAL_MACHINE;
                cred.AttributeCount = 0;
                cred.Attributes = IntPtr.Zero;
                cred.Comment = null;
                cred.TargetAlias = null;

                return CredWrite(ref cred, 0);
            }
            finally
            {
                if (blobPtr != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(blobPtr);
                }
            }
        }

        private static bool DeleteCredentialInternal(string target)
        {
            bool any = false;
            string[] names = string.IsNullOrEmpty(target)
                ? new string[] { "gemini:antigravity", "LegacyGeneric:target=gemini:antigravity" }
                : new string[] { target, "gemini:antigravity", "LegacyGeneric:target=gemini:antigravity" };
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string name in names)
            {
                if (string.IsNullOrEmpty(name) || seen.Contains(name)) continue;
                seen.Add(name);
                if (CredDelete(name, CRED_TYPE_GENERIC, 0))
                {
                    any = true;
                }
            }
            return any;
        }

        private static int HandleCredRead(string target)
        {
            WriteJson(ReadCredentialInternal(target));
            return 0;
        }

        private static int HandleCredWrite()
        {
            string raw = ReadAllStdin();
            Dictionary<string, object> req = CreateSerializer().Deserialize<Dictionary<string, object>>(raw);
            if (req == null)
            {
                WriteJson(new Dictionary<string, object> { { "ok", false }, { "error", "invalid stdin payload" } });
                return 1;
            }
            string target = GetString(req, "target", "gemini:antigravity");
            string userName = GetString(req, "userName", "antigravity");
            int persist = GetInt(req, "persist", CRED_PERSIST_LOCAL_MACHINE);
            string blobB64 = GetString(req, "blobBase64", "");
            byte[] blob = string.IsNullOrEmpty(blobB64) ? new byte[0] : Convert.FromBase64String(blobB64);

            bool ok = WriteCredentialInternal(target, userName, persist, blob);
            if (!ok)
            {
                int err = Marshal.GetLastWin32Error();
                WriteJson(new Dictionary<string, object> { { "ok", false }, { "error", "CredWriteW failed: Win32=" + err } });
                return 1;
            }
            WriteJson(new Dictionary<string, object> { { "ok", true }, { "target", target } });
            return 0;
        }

        private static int HandleCredDelete(string target)
        {
            bool deleted = DeleteCredentialInternal(target);
            WriteJson(new Dictionary<string, object> { { "ok", true }, { "deleted", deleted } });
            return 0;
        }

        private static int HandleDpapiProtect()
        {
            string raw = ReadAllStdin();
            byte[] plain = Encoding.UTF8.GetBytes(raw ?? "");
            byte[] cipher = ProtectedData.Protect(plain, DpapiEntropy, DataProtectionScope.CurrentUser);
            WriteJson(new Dictionary<string, object>
            {
                { "ok", true },
                { "cipherBase64", Convert.ToBase64String(cipher) }
            });
            return 0;
        }

        private static int HandleDpapiUnprotect()
        {
            string raw = (ReadAllStdin() ?? "").Trim();
            if (string.IsNullOrEmpty(raw))
            {
                WriteJson(new Dictionary<string, object> { { "ok", false }, { "error", "empty cipher" } });
                return 1;
            }
            byte[] cipher = Convert.FromBase64String(raw);
            byte[] plain = ProtectedData.Unprotect(cipher, DpapiEntropy, DataProtectionScope.CurrentUser);
            WriteJson(new Dictionary<string, object>
            {
                { "ok", true },
                { "plainText", Encoding.UTF8.GetString(plain) }
            });
            return 0;
        }

        private static string GetString(Dictionary<string, object> dict, string key, string fallback)
        {
            object val;
            if (dict != null && dict.TryGetValue(key, out val) && val != null)
            {
                return Convert.ToString(val);
            }
            return fallback;
        }

        private static int GetInt(Dictionary<string, object> dict, string key, int fallback)
        {
            object val;
            if (dict != null && dict.TryGetValue(key, out val) && val != null)
            {
                try { return Convert.ToInt32(val); } catch { }
            }
            return fallback;
        }

        private static void AtomicWriteUtf8(string filePath, string content)
        {
            string dir = Path.GetDirectoryName(filePath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }
            string tmp = filePath + ".tmp." + Process.GetCurrentProcess().Id + "." + Environment.TickCount;
            File.WriteAllText(tmp, content ?? "", new UTF8Encoding(false));
            for (int i = 0; i < 6; i++)
            {
                try
                {
                    if (File.Exists(filePath))
                    {
                        File.Replace(tmp, filePath, null, true);
                    }
                    else
                    {
                        File.Move(tmp, filePath);
                    }
                    return;
                }
                catch
                {
                    if (i == 5)
                    {
                        try { File.Copy(tmp, filePath, true); } finally { try { File.Delete(tmp); } catch { } }
                        return;
                    }
                    Thread.Sleep(80 * (i + 1));
                }
            }
        }

        private static void UpdateTxFile(string txPath, Dictionary<string, object> tx, string stage, string errorMsg)
        {
            tx["stage"] = stage;
            tx["updatedAtMs"] = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
            if (!string.IsNullOrEmpty(errorMsg))
            {
                tx["error"] = errorMsg;
            }
            try
            {
                AtomicWriteUtf8(txPath, CreateSerializer().Serialize(tx));
            }
            catch { }
        }

        private static bool IsAntigravityProcessName(string procName)
        {
            return string.Equals(procName, "Antigravity", StringComparison.OrdinalIgnoreCase)
                || string.Equals(procName, "Antigravity_Original", StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsAnyAntigravityAlive()
        {
            return IsProcessAliveByName("Antigravity") || IsProcessAliveByName("Antigravity_Original");
        }

        private static List<Process> FindHostProcesses(int selfPid)
        {
            List<Process> list = new List<Process>();
            string[] names = new string[] { "Antigravity", "Antigravity_Original", "language_server" };
            foreach (string name in names)
            {
                try
                {
                    Process[] found = Process.GetProcessesByName(name);
                    foreach (Process p in found)
                    {
                        if (p.Id == selfPid) continue;
                        list.Add(p);
                    }
                }
                catch { }
            }
            return list;
        }

        private static void CloseHostGracefullyAndWait(int gracefulTimeoutMs, int forceTimeoutMs)
        {
            int selfPid = Process.GetCurrentProcess().Id;
            List<Process> initial = FindHostProcesses(selfPid);
            if (initial.Count == 0) return;

            HashSet<uint> targetPids = new HashSet<uint>();
            foreach (Process p in initial)
            {
                try
                {
                    if (IsAntigravityProcessName(p.ProcessName))
                    {
                        targetPids.Add((uint)p.Id);
                        try { p.CloseMainWindow(); } catch { }
                    }
                }
                catch { }
            }

            // Send WM_CLOSE to all visible top-level windows owned by Antigravity.exe
            try
            {
                EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
                {
                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    if (targetPids.Contains(pid) && IsWindowVisible(hWnd))
                    {
                        PostMessage(hWnd, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
                    }
                    return true;
                }, IntPtr.Zero);
            }
            catch { }

            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < gracefulTimeoutMs)
            {
                List<Process> alive = FindHostProcesses(selfPid);
                if (alive.Count == 0) return;
                Thread.Sleep(150);
            }

            // Fallback termination only for lingering processes after graceful window
            List<Process> lingering = FindHostProcesses(selfPid);
            foreach (Process p in lingering)
            {
                try
                {
                    if (!p.HasExited)
                    {
                        p.Kill();
                    }
                }
                catch { }
            }

            Stopwatch sw2 = Stopwatch.StartNew();
            while (sw2.ElapsedMilliseconds < forceTimeoutMs)
            {
                List<Process> alive = FindHostProcesses(selfPid);
                if (alive.Count == 0) break;
                Thread.Sleep(120);
            }
            // Extra settle period for OS file locks & SQLite WAL handles
            Thread.Sleep(350);
        }

        private static Dictionary<string, object> CaptureLiveHostSnapshot(string roamingDir)
        {
            Dictionary<string, object> snap = new Dictionary<string, object>();
            snap["credential"] = ReadCredentialInternal("gemini:antigravity");

            string scopePath = Path.Combine(roamingDir, "credential-user-scope");
            if (File.Exists(scopePath))
            {
                try { snap["credentialUserScope"] = File.ReadAllText(scopePath, new UTF8Encoding(false)); } catch { }
            }

            string appStoragePath = Path.Combine(roamingDir, "app_storage.json");
            if (File.Exists(appStoragePath))
            {
                try
                {
                    string txt = File.ReadAllText(appStoragePath, new UTF8Encoding(false));
                    Dictionary<string, object> parsed = CreateSerializer().Deserialize<Dictionary<string, object>>(txt);
                    if (parsed != null)
                    {
                        object lastUser;
                        if (parsed.TryGetValue("agy.onboarding.lastLoginUsername", out lastUser) && lastUser != null)
                        {
                            snap["lastLoginUsername"] = Convert.ToString(lastUser);
                        }
                    }
                }
                catch { }
            }
            return snap;
        }

        private static void ApplyAppStorageUsername(string roamingDir, string email, bool clearMode)
        {
            string appStoragePath = Path.Combine(roamingDir, "app_storage.json");
            if (!File.Exists(appStoragePath)) return;

            string raw = File.ReadAllText(appStoragePath, new UTF8Encoding(false));
            JavaScriptSerializer ser = CreateSerializer();
            Dictionary<string, object> parsed = ser.Deserialize<Dictionary<string, object>>(raw);
            if (parsed == null) return;

            if (clearMode)
            {
                parsed.Remove("agy.onboarding.lastLoginUsername");
            }
            else if (!string.IsNullOrEmpty(email))
            {
                parsed["agy.onboarding.lastLoginUsername"] = email;
            }
            AtomicWriteUtf8(appStoragePath, ser.Serialize(parsed));
        }

        private static void RestoreSnapshot(string roamingDir, Dictionary<string, object> snap)
        {
            if (snap == null) return;
            object credObj;
            if (snap.TryGetValue("credential", out credObj))
            {
                Dictionary<string, object> cred = credObj as Dictionary<string, object>;
                if (cred != null && Convert.ToBoolean(cred["found"]))
                {
                    string target = GetString(cred, "target", "gemini:antigravity");
                    string userName = GetString(cred, "userName", "antigravity");
                    int persist = GetInt(cred, "persist", CRED_PERSIST_LOCAL_MACHINE);
                    string b64 = GetString(cred, "blobBase64", "");
                    WriteCredentialInternal(target, userName, persist, Convert.FromBase64String(b64));
                }
            }
            string scopePath = Path.Combine(roamingDir, "credential-user-scope");
            string prevScope = GetString(snap, "credentialUserScope", null);
            if (prevScope != null)
            {
                AtomicWriteUtf8(scopePath, prevScope);
            }
            string prevUser = GetString(snap, "lastLoginUsername", null);
            if (prevUser != null)
            {
                try { ApplyAppStorageUsername(roamingDir, prevUser, false); } catch { }
            }
        }

        private static bool IsProcessAliveByName(string procName)
        {
            try
            {
                Process[] list = Process.GetProcessesByName(procName);
                foreach (Process p in list)
                {
                    try
                    {
                        if (!p.HasExited) return true;
                    }
                    catch { }
                }
            }
            catch { }
            return false;
        }

        private static void StripPollutedEnvVars(ProcessStartInfo psi)
        {
            string[] exactKeys = new string[]
            {
                "ELECTRON_RUN_AS_NODE",
                "ELECTRON_NO_ATTACH_CONSOLE",
                "ELECTRON_NO_ASAR",
                "NODE_OPTIONS",
                "NODE_EXTRA_CA_CERTS"
            };
            List<string> toRemove = new List<string>();
            foreach (System.Collections.DictionaryEntry entry in psi.EnvironmentVariables)
            {
                string k = entry.Key as string;
                if (string.IsNullOrEmpty(k)) continue;
                string upper = k.ToUpperInvariant();
                bool match = false;
                for (int i = 0; i < exactKeys.Length; i++)
                {
                    if (upper == exactKeys[i]) { match = true; break; }
                }
                if (!match && (upper.StartsWith("ANTIGRAVITY_") || upper.StartsWith("AGY_") || upper.StartsWith("VSCODE_")))
                {
                    match = true;
                }
                if (match) toRemove.Add(k);
            }
            foreach (string k in toRemove)
            {
                try { psi.EnvironmentVariables.Remove(k); } catch { }
            }
        }

        private static int RelaunchAntigravity(string exePath, string launchArgs, string workDir)
        {
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return 0;

            string resolvedWorkDir = (!string.IsNullOrEmpty(workDir) && Directory.Exists(workDir))
                ? workDir
                : Path.GetDirectoryName(exePath);

            // Attempt 1: direct launch with clean environment (ELECTRON_RUN_AS_NODE stripped) and preserved args (e.g. CDP port)
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = exePath;
                psi.Arguments = launchArgs ?? "";
                psi.UseShellExecute = false;
                psi.CreateNoWindow = false;
                if (!string.IsNullOrEmpty(resolvedWorkDir) && Directory.Exists(resolvedWorkDir))
                {
                    psi.WorkingDirectory = resolvedWorkDir;
                }
                StripPollutedEnvVars(psi);
                Process started = Process.Start(psi);
                Thread.Sleep(1400);
                if (started != null && !started.HasExited)
                {
                    return started.Id;
                }
                if (IsAnyAntigravityAlive())
                {
                    return started != null ? started.Id : 1;
                }
            }
            catch { }

            // Attempt 2: clean launch without custom arguments
            if (!string.IsNullOrEmpty(launchArgs))
            {
                try
                {
                    ProcessStartInfo psi2 = new ProcessStartInfo();
                    psi2.FileName = exePath;
                    psi2.Arguments = "";
                    psi2.UseShellExecute = false;
                    psi2.CreateNoWindow = false;
                    if (!string.IsNullOrEmpty(resolvedWorkDir) && Directory.Exists(resolvedWorkDir))
                    {
                        psi2.WorkingDirectory = resolvedWorkDir;
                    }
                    StripPollutedEnvVars(psi2);
                    Process started2 = Process.Start(psi2);
                    Thread.Sleep(1400);
                    if ((started2 != null && !started2.HasExited) || IsAnyAntigravityAlive())
                    {
                        return started2 != null ? started2.Id : 1;
                    }
                }
                catch { }
            }

            // Attempt 3: delegate to explorer.exe so it inherits a completely fresh Windows shell environment
            try
            {
                ProcessStartInfo psi3 = new ProcessStartInfo();
                psi3.FileName = "explorer.exe";
                psi3.Arguments = "\"" + exePath + "\"";
                psi3.UseShellExecute = true;
                Process.Start(psi3);
                Thread.Sleep(1200);
                return IsAnyAntigravityAlive() ? 1 : 0;
            }
            catch
            {
                return 0;
            }
        }

        private static int HandleSwitchDaemon(string txPath)
        {
            // Small initial delay so HTTP response reaches the frontend before closing host
            Thread.Sleep(450);

            JavaScriptSerializer ser = CreateSerializer();
            Dictionary<string, object> tx;
            try
            {
                string txRaw = File.ReadAllText(txPath, new UTF8Encoding(false));
                tx = ser.Deserialize<Dictionary<string, object>>(txRaw);
            }
            catch
            {
                return 2;
            }
            if (tx == null) return 2;

            string mode = GetString(tx, "mode", "switch");
            string roamingDir = GetString(tx, "roamingDir", Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Antigravity"));
            string antigravityExe = GetString(tx, "antigravityExe", "");
            string launchArgs = GetString(tx, "launchArgs", "");
            string workDir = GetString(tx, "workDir", "");
            string payloadFile = GetString(tx, "payloadFile", "");
            string backupFile = GetString(tx, "backupFile", "");
            string targetEmail = GetString(tx, "targetEmail", "");

            Dictionary<string, object> preSwitchSnapshot = null;

            try
            {
                UpdateTxFile(txPath, tx, "closing_host", null);
                CloseHostGracefullyAndWait(6500, 2500);

                UpdateTxFile(txPath, tx, "backing_up", null);
                preSwitchSnapshot = CaptureLiveHostSnapshot(roamingDir);
                if (!string.IsNullOrEmpty(backupFile))
                {
                    try
                    {
                        byte[] snapBytes = Encoding.UTF8.GetBytes(ser.Serialize(preSwitchSnapshot));
                        byte[] cipher = ProtectedData.Protect(snapBytes, DpapiEntropy, DataProtectionScope.CurrentUser);
                        AtomicWriteUtf8(backupFile, Convert.ToBase64String(cipher));
                    }
                    catch { }
                }

                UpdateTxFile(txPath, tx, "applying", null);
                string scopePath = Path.Combine(roamingDir, "credential-user-scope");

                if (mode == "oauth_new")
                {
                    DeleteCredentialInternal("gemini:antigravity");
                    try
                    {
                        if (File.Exists(scopePath)) File.Delete(scopePath);
                    }
                    catch { }
                    try { ApplyAppStorageUsername(roamingDir, "", true); } catch { }
                }
                else if (mode == "rollback")
                {
                    string restoreFrom = GetString(tx, "restoreBackupFile", "");
                    if (string.IsNullOrEmpty(restoreFrom) || !File.Exists(restoreFrom))
                    {
                        throw new Exception("Backup snapshot file not found");
                    }
                    string b64 = File.ReadAllText(restoreFrom, new UTF8Encoding(false)).Trim();
                    byte[] plain = ProtectedData.Unprotect(Convert.FromBase64String(b64), DpapiEntropy, DataProtectionScope.CurrentUser);
                    Dictionary<string, object> snap = ser.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(plain));
                    if (snap == null)
                    {
                        throw new Exception("Invalid backup snapshot");
                    }
                    RestoreSnapshot(roamingDir, snap);
                }
                else
                {
                    if (string.IsNullOrEmpty(payloadFile) || !File.Exists(payloadFile))
                    {
                        throw new Exception("Missing encrypted switch payload");
                    }
                    string cipherText = File.ReadAllText(payloadFile, new UTF8Encoding(false)).Trim();
                    byte[] plainBytes = ProtectedData.Unprotect(Convert.FromBase64String(cipherText), DpapiEntropy, DataProtectionScope.CurrentUser);
                    Dictionary<string, object> payload = ser.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(plainBytes));
                    if (payload == null)
                    {
                        throw new Exception("Invalid decrypted switch payload");
                    }

                    string credTarget = GetString(payload, "credTarget", "gemini:antigravity");
                    string credUserName = GetString(payload, "credUserName", "antigravity");
                    int credPersist = GetInt(payload, "credPersist", CRED_PERSIST_LOCAL_MACHINE);
                    string credJson = GetString(payload, "credJson", "");
                    if (string.IsNullOrEmpty(credJson))
                    {
                        throw new Exception("Target credential JSON is empty");
                    }

                    byte[] credBlob = new UTF8Encoding(false).GetBytes(credJson);
                    bool written = WriteCredentialInternal(credTarget, credUserName, credPersist, credBlob);
                    if (!written)
                    {
                        throw new Exception("CredWriteW failed: Win32=" + Marshal.GetLastWin32Error());
                    }

                    // Read-back verification to guarantee the new account credential persisted cleanly
                    Dictionary<string, object> verify = ReadCredentialInternal(credTarget);
                    string verifyB64 = GetString(verify, "blobBase64", "");
                    if (!Convert.ToBoolean(verify["found"]) || verifyB64 != Convert.ToBase64String(credBlob))
                    {
                        throw new Exception("Credential read-back verification mismatch");
                    }
                    tx["verifiedCredBytes"] = credBlob.Length;

                    string targetScope = GetString(payload, "credentialUserScope", "");
                    if (!string.IsNullOrEmpty(targetScope))
                    {
                        AtomicWriteUtf8(scopePath, targetScope);
                    }
                    else
                    {
                        // Remove stale previous user scope so Antigravity generates a clean scope bound to the switched user
                        try { if (File.Exists(scopePath)) File.Delete(scopePath); } catch { }
                    }

                    try { ApplyAppStorageUsername(roamingDir, targetEmail, false); } catch { }

                    // Optional Antigravity 1.x state.vscdb sync when target payload includes v1State
                    string v1NodeExe = GetString(tx, "v1SyncNodeExe", "");
                    string v1Script = GetString(tx, "v1SyncScript", "");
                    if (!string.IsNullOrEmpty(v1NodeExe) && !string.IsNullOrEmpty(v1Script) && File.Exists(v1NodeExe) && File.Exists(v1Script))
                    {
                        try
                        {
                            ProcessStartInfo nsi = new ProcessStartInfo();
                            nsi.FileName = v1NodeExe;
                            nsi.Arguments = "\"" + v1Script + "\" \"" + roamingDir + "\" \"" + payloadFile + "\"";
                            nsi.UseShellExecute = false;
                            nsi.CreateNoWindow = true;
                            nsi.WindowStyle = ProcessWindowStyle.Hidden;
                            Process np = Process.Start(nsi);
                            if (np != null)
                            {
                                np.WaitForExit(8000);
                            }
                        }
                        catch { }
                    }
                }

                // Clean up temporary one-time encrypted payload
                if (!string.IsNullOrEmpty(payloadFile))
                {
                    try { if (File.Exists(payloadFile)) File.Delete(payloadFile); } catch { }
                }

                UpdateTxFile(txPath, tx, "relaunching", null);
                int relaunchedPid = RelaunchAntigravity(antigravityExe, launchArgs, workDir);
                tx["relaunchedPid"] = relaunchedPid;

                UpdateTxFile(txPath, tx, relaunchedPid > 0 ? "done" : "relaunch_failed", relaunchedPid > 0 ? null : "Antigravity relaunch did not stay alive");
                return relaunchedPid > 0 ? 0 : 1;
            }
            catch (Exception ex)
            {
                // Automatic rollback on any write failure
                try
                {
                    if (preSwitchSnapshot != null)
                    {
                        RestoreSnapshot(roamingDir, preSwitchSnapshot);
                    }
                }
                catch { }

                if (!string.IsNullOrEmpty(payloadFile))
                {
                    try { if (File.Exists(payloadFile)) File.Delete(payloadFile); } catch { }
                }

                UpdateTxFile(txPath, tx, "failed", ex.Message);

                // Always bring Antigravity back up even on failure so the user is never stranded
                try { RelaunchAntigravity(antigravityExe, launchArgs, workDir); } catch { }
                return 1;
            }
        }
    }
}
