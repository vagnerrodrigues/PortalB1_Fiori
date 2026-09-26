sap.ui.define(["portal/b1/controller/BaseController", "sap/ui/model/json/JSONModel"], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Approvals", {
    onInit: function () {
      this.setModel(new JSONModel([]), "apr");
      this.getRouter().getRoute("compras.approvals").attachPatternMatched(this.onRefresh, this);
    },

    onRefresh: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/compras/approvals")).then(function (a) {
        this.getModel("apr").setData(a);
      }.bind(this)).catch(function () {});
    },

    onOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("apr").getObject();
      this.navToDoc(o.kind || "pr", "draft", o.draftEntry, { mode: "approve", code: o.approvalCode });
    }
  });
});
