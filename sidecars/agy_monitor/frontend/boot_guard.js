/**
 * Classic deferred boot watchdog so sandbox/CSP/CORS/script load failures
 * surface visibly instead of leaving #activeConvName stuck on "同步中…".
 */
(function () {
  var reported = false;
  function showBootDiagnostic(message) {
    if (reported || window.__agyMonitorMounted) return;
    reported = true;
    var el = document.getElementById("activeConvName");
    if (el) {
      el.textContent = message;
    }
    var chip = document.getElementById("activeConvChip");
    if (chip && message) {
      chip.title = message;
    }
  }

  var timer = setTimeout(function () {
    if (window.__agyMonitorMounted) return;
    var lang = String(document.documentElement.lang || "").toLowerCase();
    var phase = window.__agyBundleExecuted ? "mount" : "load";
    showBootDiagnostic(
      lang.startsWith("en")
        ? "Init failed (" + phase + ") — reload panel"
        : "初始化未完成(" + phase + ")，请刷新"
    );
  }, 4500);

  window.addEventListener(
    "error",
    function (event) {
      if (window.__agyMonitorMounted) return;
      clearTimeout(timer);
      var msg =
        event && event.message
          ? String(event.message)
          : event && event.target && event.target.src
            ? "Load error: " + String(event.target.src).split("/").pop()
            : "前端脚本加载异常";
      showBootDiagnostic(msg.slice(0, 64));
    },
    true
  );

  window.addEventListener("unhandledrejection", function (event) {
    if (window.__agyMonitorMounted) return;
    clearTimeout(timer);
    var reason = event && event.reason ? event.reason.message || String(event.reason) : "Promise error";
    showBootDiagnostic(String(reason).slice(0, 64));
  });

  window.addEventListener("securitypolicyviolation", function (event) {
    if (window.__agyMonitorMounted) return;
    clearTimeout(timer);
    showBootDiagnostic("CSP: " + String(event.violatedDirective || "blocked").slice(0, 48));
  });
})();
