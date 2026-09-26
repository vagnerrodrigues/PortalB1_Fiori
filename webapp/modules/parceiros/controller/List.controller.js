sap.ui.define(["portal/b1/controller/BaseController", "sap/ui/model/json/JSONModel"], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.parceiros.controller.List", {
    onInit: function () {
      this.setModel(new JSONModel({ type: "", items: [] }), "bp");
      this.getRouter().getRoute("parceiros.list").attachPatternMatched(this.onSearch, this);
    },

    onLiveSearch: function () {
      clearTimeout(this._t);
      this._t = setTimeout(this.onSearch.bind(this), 350);
    },

    onSearch: function () {
      if (!this.routeOk()) { return; }
      var oModel = this.getModel("bp");
      var sQuery = "?q=" + encodeURIComponent(this.byId("search").getValue() || "") +
        "&type=" + encodeURIComponent(oModel.getProperty("/type") || "");
      this.busy(this.api.get("/api/m/parceiros" + sQuery)).then(function (a) {
        oModel.setProperty("/items", a);
      }).catch(function () {});
    },

    onOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("bp").getObject();
      this.getRouter().navTo("parceiros.detail", { cardCode: o.cardCode });
    },

    onNew: function () { this.getRouter().navTo("parceiros.new"); }
  });
});
