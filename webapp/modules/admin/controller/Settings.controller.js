sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  var PRESETS = {
    o365: { host: "smtp.office365.com", port: 587, security: "starttls" },
    gmail: { host: "smtp.gmail.com", port: 465, security: "ssl" },
    other: { host: "", port: 587, security: "starttls" }
  };

  return BaseController.extend("portal.b1.modules.admin.controller.Settings", {
    onInit: function () {
      this.setModel(new JSONModel({}), "cfg");
      this.getRouter().getRoute("admin.settings").attachPatternMatched(this._load, this);
    },

    _load: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/admin/settings")).then(function (o) {
        o.password = "";
        o.testTo = "";
        this.getModel("cfg").setData(o);
      }.bind(this)).catch(function () {});
    },

    onPreset: function (sKey) {
      var oModel = this.getModel("cfg");
      var p = PRESETS[sKey];
      oModel.setProperty("/email/host", p.host);
      oModel.setProperty("/email/port", p.port);
      oModel.setProperty("/email/security", p.security);
      if (sKey === "gmail") { this.toast(this.text("admGmailHint")); }
    },

    _payload: function () {
      var d = this.getModel("cfg").getData();
      var email = Object.assign({}, d.email);
      delete email.hasPassword;
      if (d.password) { email.password = d.password; }
      return { general: d.general, email: email, notify: d.notify };
    },

    onSave: function () {
      return this.busy(this.api.put("/api/m/admin/settings", this._payload())).then(function (o) {
        o.password = "";
        o.testTo = this.getModel("cfg").getProperty("/testTo");
        this.getModel("cfg").setData(o);
        this.getOwnerComponent().setBranding(o.branding); // nome novo já no topo
        // módulos que dependem das configurações (ex.: Assistente de IA) aparecem sem novo login
        this.api.get("/api/me").then(function (oMe) { this.getOwnerComponent().setSession(oMe); }.bind(this)).catch(function () {});
        this.toast(this.text("admSaved"));
      }.bind(this)).catch(function () {});
    },

    // Salva antes de testar (o teste usa a configuração gravada no servidor)
    onTestEmail: function () {
      var sTo = this.getModel("cfg").getProperty("/testTo") || this.getModel("session").getProperty("/user/email");
      this.onSave().then(function () {
        return this.busy(this.api.post("/api/m/admin/settings/test-email", { to: sTo }));
      }.bind(this)).then(function (r) {
        if (r) { MessageBox.success(this.text("admTestOk", [r.to])); }
      }.bind(this)).catch(function () {});
    }
  });
});
