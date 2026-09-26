sap.ui.define(["portal/b1/controller/BaseController", "sap/ui/model/json/JSONModel"], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.despesas.controller.Mine", {
    onInit: function () {
      this.setModel(new JSONModel([]), "list");
      this.getRouter().getRoute("despesas.mine").attachPatternMatched(this.onRefresh, this);
    },
    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/despesas")).then(function (a) {
        a.forEach(function (x) { x.comments = String(x.comments || "").replace(/^\[DESPESA\]\s*/, ""); });
        this.getModel("list").setData(a);
      }.bind(this)).catch(function () {});
    },
    onOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("list").getObject();
      this.getRouter().navTo("despesas.detail", { source: o.source, entry: o.entry });
    },
    onNew: function () { this.getRouter().navTo("despesas.new"); }
  });
});
