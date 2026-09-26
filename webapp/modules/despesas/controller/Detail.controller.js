sap.ui.define(["portal/b1/controller/BaseController", "sap/ui/model/json/JSONModel"], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.despesas.controller.Detail", {
    onInit: function () {
      this.setModel(new JSONModel({}), "doc");
      this.getRouter().getRoute("despesas.detail").attachPatternMatched(this._onMatched, this);
    },
    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      var a = oEvent.getParameter("arguments");
      this._source = a.source;
      this._entry = a.entry;
      this._load();
    },
    _load: function () {
      this.getModel("doc").setData({});
      this.busy(this.api.get("/api/m/despesas/" + this._source + "/" + this._entry)).then(function (o) {
        o.purpose = String(o.comments || "").replace(/^\[DESPESA\]\s*/, "");
        o.attachmentBase = "/api/m/despesas/" + this._source + "/" + this._entry + "/attachments";
        this.getModel("doc").setData(o);
      }.bind(this)).catch(function () {});
    },
    onFinalize: function () {
      this.busy(this.api.post("/api/m/despesas/draft/" + this._entry + "/finalize")).then(function () {
        this.toast(this.text("expFinalized"));
        this._load();
      }.bind(this)).catch(function () {});
    }
  });
});
