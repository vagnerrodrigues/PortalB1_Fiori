sap.ui.define(["./BaseController"], function (BaseController) {
  "use strict";
  return BaseController.extend("portal.b1.controller.App", {
    onInit: function () {
      this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
    }
  });
});
