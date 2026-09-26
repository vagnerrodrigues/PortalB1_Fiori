sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/Dialog",
  "sap/m/TextArea",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, Dialog, TextArea, Button, Label, MessageBox) {
  "use strict";
  return BaseController.extend("portal.b1.modules.compras.controller.Detail", {
    onInit: function () {
      this.setModel(new JSONModel({}), "doc");
      this.setModel(new JSONModel({ mode: "view", approvalCode: null }), "view");
      this.getRouter().getRoute("compras.detail").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      var oArgs = oEvent.getParameter("arguments");
      var oQuery = oArgs["?query"] || {};
      this._source = oArgs.source;
      this._entry = oArgs.entry;
      this.getModel("view").setData({ mode: oQuery.mode === "approve" ? "approve" : "view", approvalCode: oQuery.code || null });
      this._load();
    },

    _load: function () {
      this.getModel("doc").setData({});
      return this.busy(this.api.get("/api/m/compras/purchase-requests/" + this._source + "/" + this._entry)).then(function (o) {
        o.attachmentBase = "/api/m/compras/purchase-requests/" + this._source + "/" + this._entry + "/attachments";
        this.getModel("doc").setData(o);
      }.bind(this)).catch(function () {});
    },

    onOpenGenerated: function () {
      var g = this.getModel("doc").getProperty("/generated");
      if (g) { this.getRouter().navTo("compras.detail", { source: "doc", entry: g.entry }); }
    },

    // Requisitante efetiva o rascunho aprovado (mesmo comportamento do B1: originador gera o documento)
    onFinalize: function () {
      this.busy(this.api.post("/api/m/compras/purchase-requests/draft/" + this._entry + "/finalize")).then(function () {
        this.toast(this.text("finalized"));
        this.getRouter().navTo("compras.mine", {}, true);
      }.bind(this)).catch(function () {});
    },

    onDecide: function (bApprove) {
      var oText = new TextArea({ width: "100%", rows: 3, maxLength: 254 });
      var oDialog = new Dialog({
        title: this.text(bApprove ? "approve" : "reject"),
        type: "Message",
        content: [new Label({ text: this.text("remarks"), labelFor: oText, required: !bApprove }), oText],
        beginButton: new Button({
          text: this.text("confirm"),
          type: bApprove ? "Accept" : "Reject",
          press: function () {
            var sRemarks = oText.getValue().trim();
            if (!bApprove && !sRemarks) { MessageBox.warning(this.text("rejectReasonRequired")); return; }
            oDialog.close();
            this._sendDecision(bApprove, sRemarks);
          }.bind(this)
        }),
        endButton: new Button({ text: this.text("cancel"), press: function () { oDialog.close(); } }),
        afterClose: function () { oDialog.destroy(); }
      });
      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    _sendDecision: function (bApprove, sRemarks) {
      var sCode = this.getModel("view").getProperty("/approvalCode") || this.getModel("doc").getProperty("/approval/code");
      this.busy(this.api.post("/api/m/compras/approvals/" + sCode + "/decision", { approve: bApprove, remarks: sRemarks })).then(function () {
        this.toast(this.text(bApprove ? "approved" : "rejected"));
        this.getRouter().navTo("compras.approvals", {}, true);
      }.bind(this)).catch(function () {});
    }
  });
});
