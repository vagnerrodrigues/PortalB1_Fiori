sap.ui.define(["./BaseController", "sap/ui/model/json/JSONModel", "sap/m/MessageBox"], function (BaseController, JSONModel, MessageBox) {
  "use strict";
  return BaseController.extend("portal.b1.controller.Login", {
    onInit: function () {
      this.setModel(new JSONModel({ tenants: [], tenantId: "", userName: "", password: "", demo: false }), "login");
      this.getRouter().getRoute("login").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function () {
      var oModel = this.getModel("login");
      oModel.setProperty("/password", "");
      this.api.get("/api/tenants").then(function (aTenants) {
        oModel.setProperty("/tenants", aTenants);
        if (!oModel.getProperty("/tenantId") && aTenants.length) { oModel.setProperty("/tenantId", aTenants[0].id); }
        oModel.setProperty("/demo", aTenants.length === 1 && aTenants[0].id === "demo");
        this.onTenantChange();
      }.bind(this));
    },

    // Cada empresa pode ter nome/marca própria: aplica já na tela de login
    onTenantChange: function () {
      var sTenant = this.getModel("login").getProperty("/tenantId");
      if (!sTenant) { return; }
      this.api.get("/api/branding?tenant=" + encodeURIComponent(sTenant)).then(function (b) {
        this.getOwnerComponent().setBranding(b);
      }.bind(this)).catch(function () {});
    },

    onLogin: function () {
      var oData = this.getModel("login").getData();
      if (!oData.tenantId || !oData.userName || !oData.password) { return; }
      this.busy(this.api.post("/api/login", {
        tenantId: oData.tenantId, userName: oData.userName, password: oData.password
      })).then(function (oRes) {
        this.getModel("login").setProperty("/password", "");
        this.getOwnerComponent().setSession(oRes);
        this.getRouter().navTo("home", {}, true);
      }.bind(this)).catch(function (oErr) {
        // busy() não mostra 401 (sessão expirada); no login, 401 é senha/licença: precisa aparecer
        if (oErr && oErr.status === 401) { MessageBox.error(oErr.message); }
      });
    }
  });
});
