sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel",
  "sap/ui/Device",
  "./model/api",
  "./model/formatter",
  "./model/branding"
], function (UIComponent, JSONModel, Device, api, formatter, branding) {
  "use strict";

  return UIComponent.extend("portal.b1.Component", {
    metadata: { manifest: "json", interfaces: ["sap.ui.core.IAsyncContentCreation"] },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      formatter.setBundle(this.getModel("i18n").getResourceBundle());
      this.setModel(new JSONModel(Device).setDefaultBindingMode("OneWay"), "device");
      // Sessão: usuário, empresa e módulos liberados para ele
      this.setModel(new JSONModel({ loggedIn: false, user: {}, tenant: {}, modules: [], mock: false }), "session");

      // Identidade visual: padrão global (tela de login) e depois a da empresa logada
      this.setModel(new JSONModel({ productName: "Portal B1", company: "", logo: "", logoOnDark: "" }), "brand");
      api.get("/api/branding").then(this.setBranding.bind(this)).catch(function () {});

      var oRouter = this.getRouter();
      api.onUnauthorized(function () {
        this.getModel("session").setProperty("/loggedIn", false);
        oRouter.navTo("login", {}, true);
      }.bind(this));

      // Guard: rota exige sessão; rota de módulo ("modulo.tela") exige acesso ao módulo
      oRouter.attachRouteMatched(function (oEvent) {
        var sName = oEvent.getParameter("name");
        if (sName === "login") { return; }
        if (!this.getModel("session").getProperty("/loggedIn")) {
          oRouter.navTo("login", {}, true);
          return;
        }
        var sModule = sName.indexOf(".") > 0 ? sName.split(".")[0] : null;
        if (sModule && !this.hasModule(sModule)) {
          oRouter.navTo("home", {}, true);
        }
      }.bind(this));

      api.get("/api/me").then(function (oMe) {
        this.setSession(oMe);
        oRouter.initialize();
      }.bind(this)).catch(function () {
        oRouter.initialize();
        oRouter.navTo("login", {}, true);
      });
    },

    setBranding: function (oBrand) {
      if (!oBrand) { return; }
      this.getModel("brand").setData(oBrand);
      branding.apply(oBrand);
    },

    setSession: function (oData) {
      this.setBranding(oData.branding);
      this.getModel("session").setData({
        loggedIn: true, user: oData.user, tenant: oData.tenant, modules: oData.modules || [], mock: !!oData.mock
      });
    },

    hasModule: function (sId) {
      return (this.getModel("session").getProperty("/modules") || []).some(function (m) { return m.id === sId; });
    },

    getContentDensityClass: function () {
      return Device.support.touch ? "sapUiSizeCozy" : "sapUiSizeCompact";
    }
  });
});
