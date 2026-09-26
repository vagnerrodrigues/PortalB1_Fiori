sap.ui.define(["portal/b1/controller/BaseController", "sap/ui/model/json/JSONModel"], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.parceiros.controller.Detail", {
    onInit: function () {
      this.setModel(new JSONModel({}), "bp");
      this.getRouter().getRoute("parceiros.detail").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      var sCode = oEvent.getParameter("arguments").cardCode;
      this.getModel("bp").setData({});
      this.busy(this.api.get("/api/m/parceiros/" + encodeURIComponent(sCode))).then(function (o) {
        this.getModel("bp").setData(o);
      }.bind(this)).catch(function () {});
    }
  });
});
