sap.ui.define(["portal/b1/controller/BaseController", "sap/ui/model/json/JSONModel"], function (BaseController, JSONModel) {
  "use strict";
  return BaseController.extend("portal.b1.modules.relatorios.controller.List", {
    onInit: function () {
      this.setModel(new JSONModel([]), "rep");
      this.getRouter().getRoute("relatorios.list").attachPatternMatched(this._load, this);
    },

    _load: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/relatorios")).then(function (a) {
        this.getModel("rep").setData(a);
        this.getOwnerComponent().getModel("session").setProperty("/reportCatalog", a);
      }.bind(this)).catch(function () {});
    },

    onOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("rep").getObject();
      this.getRouter().navTo("relatorios.run", { id: o.id });
    }
  });
});
