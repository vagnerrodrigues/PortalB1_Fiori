sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/CheckBox",
  "sap/m/Text",
  "sap/m/Label",
  "sap/m/DatePicker",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/VBox",
  "sap/m/ObjectIdentifier",
  "sap/m/ObjectNumber",
  "sap/m/ObjectStatus",
  "sap/m/Select",
  "sap/ui/core/Item"
], function (BaseController, JSONModel, MessageBox, Dialog, Button, CheckBox, Text, Label, DatePicker,
  Table, Column, ColumnListItem, VBox, ObjectIdentifier, ObjectNumber, ObjectStatus, Select, Item) {
  "use strict";

  /**
   * Mapa de cotação: uma coluna por fornecedor (montada em código, pois o número de fornecedores varia),
   * menor preço destacado por item e escolha do vencedor por item.
   */
  return BaseController.extend("portal.b1.modules.compras.controller.Rfq", {
    onInit: function () {
      this.setModel(new JSONModel({}), "rfq");
      this.setModel(new JSONModel({ tab: "map", selected: 0, winners: 0 }), "view");
      this.setModel(new JSONModel({ vendorSuggest: [] }), "md");
      this.setModel(new JSONModel({}), "ans");
      this.getRouter().getRoute("compras.rfq").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      this._id = oEvent.getParameter("arguments").id;
      this._selection = null;
      this.getModel("view").setProperty("/tab", "map");
      this.onRefresh();
    },

    /** Carrega a cotação; se há respostas ainda não gravadas no SAP, grava com a sessão do comprador. */
    onRefresh: function () {
      var sUrl = "/api/m/compras/rfq/" + this._id;
      this.getModel("rfq").setData({});
      return this.busy(this.api.get(sUrl).then(function (o) {
        var bPending = o.suppliers.some(function (s) { return s.sync === "PENDING"; });
        return bPending ? this.api.post(sUrl + "/sync").then(function (o2) { this.toast(this.text("rfqSynced")); return o2; }.bind(this)) : o;
      }.bind(this))).then(this._setData.bind(this)).catch(function () {});
    },

    _setData: function (o) {
      this.getModel("rfq").setData(o);
      var oSingle = o.map.summary.bestSingle;
      var fnName = function (sCode) {
        var s = o.suppliers.filter(function (x) { return x.cardCode === sCode; })[0];
        return s ? s.cardName : sCode;
      };
      var aErr = o.suppliers.filter(function (s) { return s.sync === "ERROR"; })
        .map(function (s) { return s.cardName + ": " + (s.syncError || ""); });
      var oView = this.getModel("view");
      oView.setProperty("/bestSingleName", oSingle ? fnName(oSingle.cardCode) : "—");
      oView.setProperty("/syncErrors", aErr.join(" · "));
      oView.setProperty("/pendingSync", o.suppliers.some(function (s) { return s.sync === "PENDING" || s.sync === "ERROR"; }));
      this._names = {};
      o.suppliers.forEach(function (s) { this._names[s.cardCode] = s.cardName; }.bind(this));
      this._selection = {};
      o.map.lines.forEach(function (l) { this._selection[l.key] = l.winner || ""; }.bind(this));
      this._buildMap();
      this._recalc();
    },

    // ---------- mapa ----------
    _buildMap: function () {
      var o = this.getModel("rfq").getData();
      var oBox = this.byId("mapBox");
      oBox.destroyItems();
      var fmt = this.formatter;
      var bLocked = o.status === "AWARDED" || o.status === "CANCELLED";
      var aSup = o.suppliers.filter(function (s) { return !!s.pq; });
      var oTable = new Table({ fixedLayout: false, popinLayout: "GridSmall", noDataText: this.text("noData") }).addStyleClass("pbMap");
      oTable.addColumn(new Column({ width: "16rem", header: new Text({ text: this.text("item") }) }));
      oTable.addColumn(new Column({ width: "7rem", hAlign: "End", header: new Text({ text: this.text("quantity") }) }));
      aSup.forEach(function (s) {
        var oTot = o.map.suppliers.filter(function (x) { return x.cardCode === s.cardCode; })[0] || {};
        oTable.addColumn(new Column({
          hAlign: "End", minScreenWidth: "Tablet", demandPopin: true, popinDisplay: "Inline",
          header: new VBox({ alignItems: "End", items: [
            new Text({ text: s.cardName, wrapping: true }).addStyleClass("pbMapSup"),
            new ObjectStatus({
              text: s.status === "ANSWERED" ? fmt.money(oTot.total) + " · " + oTot.quotedCount + "/" + o.lines.length : fmt.prefixed("supSt_", s.status),
              state: fmt.supplierState(s.status)
            })
          ] })
        }));
      });
      oTable.addColumn(new Column({ width: "14rem", header: new Text({ text: this.text("rfqWinner") }) }));

      o.map.lines.forEach(function (l) {
        var aCells = [
          new ObjectIdentifier({ title: l.itemName || l.itemCode, text: l.itemCode + (l.requiredDate ? " · " + fmt.date(l.requiredDate) : "") }),
          new ObjectNumber({ number: String(l.quantity).replace(".", ","), unit: l.uom })
        ];
        aSup.forEach(function (s) {
          var of = l.offers.filter(function (x) { return x.cardCode === s.cardCode; })[0];
          var oCell;
          if (of && of.quoted) {
            oCell = new VBox({ alignItems: "End", items: [
              new ObjectNumber({ number: fmt.money(of.unitPrice), state: of.best ? "Success" : "None", emphasized: of.best }),
              new Text({ text: fmt.money(of.total) }),
              new Text({ text: of.deliveryDate ? this.text("rfqDelivery", [fmt.date(of.deliveryDate)]) : "", visible: !!of.deliveryDate }),
              new Text({ text: of.notes || "", visible: !!of.notes, wrapping: true })
            ] });
          } else {
            oCell = new Text({ text: s.status === "ANSWERED" || s.status === "DECLINED" ? this.text("rfqNotQuoted") : this.text("rfqNoAnswer") }).addStyleClass("pbMapEmpty");
          }
          oCell.addStyleClass("pbMapCell").data("sup", s.cardCode).data("key", String(l.key));
          aCells.push(oCell);
        }.bind(this));
        var oSel = new Select({ width: "100%", enabled: !bLocked, selectedKey: this._selection[l.key] || "", change: this._onWinner.bind(this, l.key) });
        oSel.addItem(new Item({ key: "", text: this.text("rfqNoBuy") }));
        l.offers.filter(function (x) { return x.quoted; }).sort(function (a, b) { return a.unitPrice - b.unitPrice; }).forEach(function (x) {
          oSel.addItem(new Item({ key: x.cardCode, text: this._names[x.cardCode] + " · " + fmt.money(x.unitPrice) }));
        }.bind(this));
        oSel.setSelectedKey(this._selection[l.key] || "");
        aCells.push(oSel);
        oTable.addItem(new ColumnListItem({ cells: aCells }));
      }.bind(this));
      oBox.addItem(oTable);
      this._mapTable = oTable;
    },

    _onWinner: function (iKey, oEvent) {
      this._selection[iKey] = oEvent.getParameter("selectedItem").getKey();
      this._recalc();
    },

    /** Total selecionado e destaque das células vencedoras. */
    _recalc: function () {
      var o = this.getModel("rfq").getData();
      var sel = this._selection;
      var fTotal = 0, oVendors = {}, iWinners = 0;
      o.map.lines.forEach(function (l) {
        var of = l.offers.filter(function (x) { return x.cardCode === sel[l.key]; })[0];
        if (of && of.quoted) { fTotal += of.total; oVendors[of.cardCode] = true; iWinners++; }
      });
      var oView = this.getModel("view");
      oView.setProperty("/selected", Math.round(fTotal * 100) / 100);
      oView.setProperty("/winners", iWinners);
      oView.setProperty("/vendors", Object.keys(oVendors).length);
      oView.setProperty("/selectedInfo", this.text("rfqSelInfo", [iWinners, o.lines.length, Object.keys(oVendors).length]));
      if (this._mapTable) {
        this._mapTable.getItems().forEach(function (oRow) {
          oRow.getCells().forEach(function (c) {
            if (c.data("sup")) { c.toggleStyleClass("pbMapChosen", sel[Number(c.data("key"))] === c.data("sup")); }
          });
        });
      }
    },

    // ---------- ações da cotação ----------
    _post: function (sPath, oBody) {
      return this.busy(this.api.post("/api/m/compras/rfq/" + this._id + sPath, oBody)).then(function (o) {
        this._setData(o);
        return o;
      }.bind(this));
    },

    onSync: function () {
      this._post("/sync").then(function () { this.toast(this.text("rfqSynced")); }.bind(this)).catch(function () {});
    },

    onClose: function () { this._post("/close").catch(function () {}); },

    onReopen: function () {
      var d = new Date(); d.setDate(d.getDate() + 2);
      var oDate = new DatePicker({ valueFormat: "yyyy-MM-dd", displayFormat: "medium", value: this.isoDate(d), minDate: new Date() });
      var oDialog = new Dialog({
        title: this.text("rfqReopen"), type: "Message",
        content: [new Label({ text: this.text("rfqReopenAsk"), labelFor: oDate }), oDate],
        beginButton: new Button({ text: this.text("confirm"), type: "Emphasized", press: function () {
          oDialog.close();
          this._post("/reopen", { deadline: oDate.getValue() }).catch(function () {});
        }.bind(this) }),
        endButton: new Button({ text: this.text("cancel"), press: function () { oDialog.close(); } }),
        afterClose: function () { oDialog.destroy(); }
      });
      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    onCancel: function () {
      MessageBox.confirm(this.text("rfqCancelAsk"), {
        emphasizedAction: MessageBox.Action.OK,
        onClose: function (a) { if (a === MessageBox.Action.OK) { this._post("/cancel").catch(function () {}); } }.bind(this)
      });
    },

    onAward: function () {
      var n = this.getModel("view").getProperty("/vendors");
      var oChk = new CheckBox({ text: this.text("rfqAwardClose"), selected: true });
      var oDialog = new Dialog({
        title: this.text("rfqAward"), type: "Message", state: "Information",
        content: [new Text({ text: this.text("rfqAwardAsk", [n]) }).addStyleClass("sapUiSmallMarginBottom"), oChk],
        beginButton: new Button({ text: this.text("confirm"), type: "Emphasized", press: function () {
          oDialog.close();
          var sel = this._selection;
          var aSel = Object.keys(sel).filter(function (k) { return sel[k]; }).map(function (k) { return { key: Number(k), cardCode: sel[k] }; });
          this._post("/award", { selection: aSel, closeLosers: oChk.getSelected() }).then(function (o) {
            var aOk = o.award.orders.filter(function (x) { return !x.error; });
            this.toast(this.text("rfqAwarded", [aOk.map(function (x) { return x.cardName; }).join(", ")]));
            this.getModel("view").setProperty("/tab", "orders");
          }.bind(this)).catch(function () {});
        }.bind(this) }),
        endButton: new Button({ text: this.text("cancel"), press: function () { oDialog.close(); } }),
        afterClose: function () { oDialog.destroy(); }
      });
      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    // ---------- fornecedores ----------
    _supplier: function (oEvent) { return oEvent.getSource().getBindingContext("rfq").getObject(); },

    onCopyLink: function (oEvent) {
      this.copyText(this._supplier(oEvent).link).then(function () { this.toast(this.text("rfqLinkCopied")); }.bind(this));
    },

    onResend: function (oEvent) {
      var s = this._supplier(oEvent);
      this._post("/suppliers/" + encodeURIComponent(s.cardCode) + "/resend").then(function (o) {
        if (o.email && o.email.ok) { this.toast(this.text("rfqResent")); } else {
          MessageBox.warning(this.text("rfqResendFail", [(o.email && (o.email.error || o.email.skipped)) || "?"]));
        }
      }.bind(this)).catch(function () {});
    },

    onOpenOffer: function (oEvent) {
      var s = this._supplier(oEvent);
      this.navToDoc("pq", s.pq.source, s.pq.entry);
    },

    onOpenOrder: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("rfq").getObject();
      if (o.entry) { this.navToDoc("po", o.source, o.entry); }
    },

    onSupplierSuggest: function (oEvent) {
      this.suggest("/api/m/compras/vendors?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/vendorSuggest");
    },

    onSupplierPick: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var d = oItem.getBindingContext("md").getObject();
      var oInput = this.byId("supplierInput");
      setTimeout(function () { oInput.setValue(""); }, 0);
      this._post("/suppliers", { cardCode: d.cardCode }).then(function () { this.toast(this.text("rfqSupplierAdded")); }.bind(this)).catch(function () {});
    },

    onEnterAnswer: function (oEvent) {
      var s = this._supplier(oEvent);
      var o = this.getModel("rfq").getData();
      var a = s.answer || { lines: [] };
      var byKey = {};
      a.lines.forEach(function (x) { byKey[x.key] = x; });
      this._answerFor = s.cardCode;
      this.getModel("ans").setData({
        cardName: s.cardName, paymentTerms: a.paymentTerms || "", freight: a.freight || "", validUntil: a.validUntil || null, proposalRef: a.proposalRef || "",
        lines: o.lines.map(function (l) {
          var x = byKey[l.key] || {};
          return { key: l.key, itemName: l.itemName || l.itemCode, quantity: l.quantity, uom: l.uom, quoted: x.quoted !== false,
            unitPrice: x.unitPrice || null, deliveryDate: x.deliveryDate || null, notes: x.notes || "" };
        })
      });
      var p = this._answerDialog ? Promise.resolve(this._answerDialog)
        : this.loadFragment({ name: "portal.b1.modules.compras.view.fragments.RfqAnswer" }).then(function (d) { this._answerDialog = d; return d; }.bind(this));
      p.then(function (d) { d.open(); });
    },

    onAnswerClose: function () { this._answerDialog.close(); },

    onAnswerSave: function () {
      var d = this.getModel("ans").getData();
      var oBody = {
        paymentTerms: d.paymentTerms, freight: d.freight, validUntil: d.validUntil || null, proposalRef: d.proposalRef,
        lines: d.lines.map(function (l) {
          var bQuoted = l.quoted && Number(l.unitPrice) > 0;
          return { key: l.key, quoted: bQuoted, unitPrice: bQuoted ? Number(l.unitPrice) : null, deliveryDate: bQuoted ? l.deliveryDate : null, notes: l.notes };
        })
      };
      this._post("/suppliers/" + encodeURIComponent(this._answerFor) + "/answer", oBody).then(function () {
        this._answerDialog.close();
        this.toast(this.text("rfqAnswerSaved"));
        this.getModel("view").setProperty("/tab", "map");
      }.bind(this)).catch(function () {});
    }
  });
});
