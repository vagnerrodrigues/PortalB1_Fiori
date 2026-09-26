sap.ui.define([], function () {
  "use strict";
  // Cliente REST do BFF. Todas as chamadas levam o cookie de sessão (same-origin).
  var fnUnauthorized = function () {};

  function request(sMethod, sUrl, oBody) {
    return fetch(sUrl, {
      method: sMethod,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: oBody !== undefined ? JSON.stringify(oBody) : undefined
    }).then(function (oRes) {
      return oRes.json().catch(function () { return {}; }).then(function (oJson) {
        if (oRes.status === 401 && sUrl !== "/api/login" && sUrl !== "/api/me") { fnUnauthorized(); }
        if (!oRes.ok) {
          var oErr = new Error((oJson && oJson.error) || ("HTTP " + oRes.status));
          oErr.status = oRes.status;
          throw oErr;
        }
        return oJson;
      });
    });
  }

  return {
    get: function (sUrl) { return request("GET", sUrl); },
    post: function (sUrl, oBody) { return request("POST", sUrl, oBody || {}); },
    put: function (sUrl, oBody) { return request("PUT", sUrl, oBody || {}); },
    onUnauthorized: function (fn) { fnUnauthorized = fn; }
  };
});
