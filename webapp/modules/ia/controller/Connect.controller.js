sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/Text",
  "sap/m/TextArea",
  "sap/m/Select",
  "sap/m/SegmentedButton",
  "sap/m/SegmentedButtonItem",
  "sap/m/MessageStrip",
  "sap/m/VBox",
  "sap/ui/core/Item"
], function (BaseController, JSONModel, MessageBox, Dialog, Button, Label, Input, Text, TextArea, Select,
  SegmentedButton, SegmentedButtonItem, MessageStrip, VBox, Item) {
  "use strict";

  var TOKEN_PH = "<SEU_TOKEN>";

  return BaseController.extend("portal.b1.modules.ia.controller.Connect", {
    onInit: function () {
      this.setModel(new JSONModel({ enabled: false, url: "", tokens: [] }), "ia");
      this.getRouter().getRoute("ia.connect").attachPatternMatched(this._load, this);
    },

    _load: function () {
      if (!this.routeOk()) { return; }
      this.busy(this.api.get("/api/m/ia/info")).then(function (o) {
        var oModel = this.getModel("ia");
        oModel.setData(o);
        this._snippets(TOKEN_PH);
      }.bind(this)).catch(function () {});
    },

    /** Exemplos de configuração com o endereço e (quando acabou de gerar) o token. */
    _snippets: function (sToken) {
      var oModel = this.getModel("ia");
      var sUrl = oModel.getProperty("/url");
      oModel.setProperty("/snippetCode",
        "claude mcp add --transport http portal-b1 " + sUrl + " --header \"Authorization: Bearer " + sToken + "\"");
      oModel.setProperty("/snippetDesktop", JSON.stringify({
        mcpServers: {
          "portal-b1": {
            command: "npx",
            args: ["-y", "mcp-remote", sUrl, "--header", "Authorization:${PORTAL_B1_TOKEN}"],
            env: { PORTAL_B1_TOKEN: "Bearer " + sToken }
          }
        }
      }, null, 2));
    },

    onCopyUrl: function () {
      this.copyText(this.getModel("ia").getProperty("/url")).then(function () { this.toast(this.text("iaCopied")); }.bind(this));
    },

    onCopySnippet: function (sKey) {
      this.copyText(this.getModel("ia").getProperty("/" + sKey)).then(function () { this.toast(this.text("iaCopied")); }.bind(this));
    },

    onOpenSettings: function () { this.getRouter().navTo("admin.settings"); },

    onNewToken: function () {
      var oLabel = new Input({ maxLength: 40, placeholder: this.text("iaLabelPh") });
      var oScope = new SegmentedButton({ selectedKey: "read", items: [
        new SegmentedButtonItem({ key: "read", text: this.text("iaScopeRead") }),
        new SegmentedButtonItem({ key: "write", text: this.text("iaScopeWrite") })
      ] });
      var oDays = new Select({ selectedKey: "90", items: [30, 90, 180, 365].map(function (n) {
        return new Item({ key: String(n), text: this.text("iaDaysN", [n]) });
      }.bind(this)) });
      var oPwd = new Input({ type: "Password" });
      var oDialog = new Dialog({
        title: this.text("iaNewToken"), contentWidth: "32rem",
        content: [new VBox({ items: [
          new Label({ text: this.text("iaLabel"), labelFor: oLabel }), oLabel,
          new Label({ text: this.text("iaScope") }).addStyleClass("sapUiSmallMarginTop"), oScope,
          new Label({ text: this.text("iaDays"), labelFor: oDays }).addStyleClass("sapUiSmallMarginTop"), oDays,
          new Label({ text: this.text("iaPassword"), labelFor: oPwd, required: true }).addStyleClass("sapUiSmallMarginTop"), oPwd,
          new Text({ text: this.text("iaPasswordHint") }).addStyleClass("sapUiTinyMarginTop")
        ] }).addStyleClass("sapUiSmallMargin")],
        beginButton: new Button({ text: this.text("iaNewToken"), type: "Emphasized", press: function () {
          if (!oPwd.getValue()) { oPwd.setValueState("Error"); return; }
          this.busy(this.api.post("/api/m/ia/tokens", {
            label: oLabel.getValue(), scope: oScope.getSelectedKey(), days: Number(oDays.getSelectedKey()), password: oPwd.getValue()
          })).then(function (r) {
            oDialog.close();
            this._showToken(r.token);
            this._load();
          }.bind(this)).catch(function () {});
        }.bind(this) }),
        endButton: new Button({ text: this.text("cancel"), press: function () { oDialog.close(); } }),
        afterClose: function () { oDialog.destroy(); }
      });
      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    /** Mostra o token uma única vez, já com os exemplos preenchidos. */
    _showToken: function (sToken) {
      var oArea = new TextArea({ value: sToken, editable: false, width: "100%", rows: 2 }).addStyleClass("pbCode");
      var oDialog = new Dialog({
        title: this.text("iaTokenTitle"), contentWidth: "36rem", state: "Success",
        content: [new VBox({ items: [
          new MessageStrip({ text: this.text("iaTokenOnce"), type: "Warning", showIcon: true }).addStyleClass("sapUiSmallMarginBottom"),
          oArea
        ] }).addStyleClass("sapUiSmallMargin")],
        beginButton: new Button({ text: this.text("iaCopy"), icon: "sap-icon://copy", type: "Emphasized", press: function () {
          this.copyText(sToken).then(function () { this.toast(this.text("iaCopied")); }.bind(this));
        }.bind(this) }),
        endButton: new Button({ text: this.text("confirm"), press: function () { oDialog.close(); } }),
        afterClose: function () {
          oDialog.destroy();
          this._snippets(TOKEN_PH); // o token some da tela ao fechar
        }.bind(this)
      });
      this.getView().addDependent(oDialog);
      this._snippets(sToken);
      oDialog.open();
    },

    onRevoke: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("ia").getObject();
      MessageBox.confirm(this.text("iaRevokeAsk"), {
        emphasizedAction: MessageBox.Action.OK,
        onClose: function (a) {
          if (a !== MessageBox.Action.OK) { return; }
          this.busy(this.api.post("/api/m/ia/tokens/" + o.id + "/revoke")).then(function (r) {
            this.getModel("ia").setProperty("/tokens", r.tokens);
            this.toast(this.text("iaRevoked"));
          }.bind(this)).catch(function () {});
        }.bind(this)
      });
    }
  });
});
