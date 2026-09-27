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
  "sap/ui/core/Item",
  "sap/m/HBox",
  "sap/m/List",
  "sap/m/CustomListItem",
  "sap/m/Title"
], function (BaseController, JSONModel, MessageBox, Dialog, Button, CheckBox, Text, Label, DatePicker,
  Table, Column, ColumnListItem, VBox, ObjectIdentifier, ObjectNumber, ObjectStatus, Select, Item, HBox, List, CustomListItem, Title) {
  "use strict";

  /**
   * Mapa de cotação: uma coluna por fornecedor (montada em código, pois o número de fornecedores varia),
   * menor preço destacado por item e escolha do vencedor por item.
   */
  return BaseController.extend("portal.b1.modules.compras.controller.Rfq", {
    onInit: function () {
      this.setModel(new JSONModel({}), "rfq");
      this.setModel(new JSONModel({ tab: "map", selected: 0, winners: 0, criterion: "price" }), "view");
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
      this._critInfo();
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
          new VBox({ items: [
            new ObjectIdentifier({ title: l.itemName || l.itemCode, text: l.itemCode + (l.requiredDate ? " · " + fmt.date(l.requiredDate) : "") }),
            new Button({ text: this.text("rfqCompare"), icon: "sap-icon://compare", type: "Transparent", visible: l.offers.some(function (x) { return x.quoted; }),
              press: this._openCompare.bind(this, l.key) }).addStyleClass("pbMapCompare")
          ] }),
          new ObjectNumber({ number: String(l.quantity).replace(".", ","), unit: l.uom })
        ];
        aSup.forEach(function (s) {
          var of = l.offers.filter(function (x) { return x.cardCode === s.cardCode; })[0];
          var oCell;
          if (of && of.quoted) {
            oCell = new VBox({ alignItems: "End", items: [
              new ObjectNumber({ number: fmt.money(of.unitPrice), state: of.best ? "Success" : "None", emphasized: of.best }),
              new Text({ text: fmt.money(of.total) }),
              new Text({ text: of.deliveryDate ? this.text("rfqDeliveryDays", [fmt.date(of.deliveryDate), of.leadDays]) : "", visible: !!of.deliveryDate }),
              this._badges(l, of, "End"),
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

    /** Selos da proposta: menor preço, mais rápida e recomendada pelo critério ativo. */
    _badges: function (l, of, sAlign) {
      var sCrit = this.getModel("view").getProperty("/criterion");
      var aItems = [];
      if (of.best) { aItems.push(new ObjectStatus({ text: this.text("rfqBadgePrice"), state: "Success", icon: "sap-icon://trend-down", inverted: true })); }
      if (of.fastest) { aItems.push(new ObjectStatus({ text: this.text("rfqBadgeFast"), state: "Information", icon: "sap-icon://shipping-status", inverted: true })); }
      if (l.recommended && l.recommended[sCrit] === of.cardCode) {
        aItems.push(new ObjectStatus({ text: this.text("rfqBadgeRec"), state: "Indication05", icon: "sap-icon://favorite", inverted: true }));
      }
      return new HBox({ wrap: "Wrap", justifyContent: sAlign === "End" ? "End" : "Start", items: aItems.map(function (b) { return b.addStyleClass("pbBadge"); }) });
    },

    /** Troca de critério: redesenha os selos e mostra o resultado do critério. */
    onCriterion: function () {
      this._critInfo();
      this._buildMap();
      this._recalc();
    },

    _critInfo: function () {
      var o = this.getModel("rfq").getData();
      var c = o.map && o.map.byCriterion && o.map.byCriterion[this.getModel("view").getProperty("/criterion")];
      this.getModel("view").setProperty("/critInfo", c ? this.text("rfqCritInfo", [this.formatter.money(c.total), c.avgDays === null ? "–" : String(c.avgDays).replace(".", ","), c.vendors]) : "");
    },

    /** Escolhe, em todos os itens, o fornecedor recomendado pelo critério ativo. */
    onApplyCriterion: function () {
      var sCrit = this.getModel("view").getProperty("/criterion");
      this.getModel("rfq").getProperty("/map/lines").forEach(function (l) {
        if (l.recommended && l.recommended[sCrit]) { this._selection[l.key] = l.recommended[sCrit]; }
      }.bind(this));
      this._buildMap();
      this._recalc();
      this.toast(this.text("rfqApplied", [this.text("crit_" + sCrit)]));
    },

    /** Comparativo do item: propostas ranqueadas pelo critério ativo, com "Escolher". */
    _openCompare: function (iKey) {
      var o = this.getModel("rfq").getData();
      var fmt = this.formatter;
      var sCrit = this.getModel("view").getProperty("/criterion");
      var l = o.map.lines.filter(function (x) { return x.key === iKey; })[0];
      var bLocked = o.status === "AWARDED" || o.status === "CANCELLED";
      var sort = {
        price: function (a, b) { return a.unitPrice - b.unitPrice; },
        speed: function (a, b) { return ((a.leadDays === null ? 1e9 : a.leadDays) - (b.leadDays === null ? 1e9 : b.leadDays)) || a.unitPrice - b.unitPrice; },
        balance: function (a, b) { return (b.score - a.score) || a.unitPrice - b.unitPrice; }
      }[sCrit];
      var aOffers = l.offers.filter(function (x) { return x.quoted; }).sort(sort);
      var oDialog;
      var oList = new List({ showSeparators: "None" });
      aOffers.forEach(function (of, i) {
        var bChosen = this._selection[l.key] === of.cardCode;
        oList.addItem(new CustomListItem({ content: [new VBox({ items: [
          new HBox({ justifyContent: "SpaceBetween", alignItems: "Center", items: [
            new VBox({ items: [
              new Title({ text: (i + 1) + ". " + this._names[of.cardCode], level: "H4" }),
              this._badges(l, of, "Start")
            ] }),
            new VBox({ alignItems: "End", items: [
              new ObjectNumber({ number: fmt.money(of.total), emphasized: true, state: i === 0 ? "Success" : "None" }).addStyleClass("pbKpiValue"),
              new Text({ text: this.text("rfqScore", [String(of.score).replace(".", ",")]) })
            ] })
          ] }),
          new HBox({ wrap: "Wrap", items: [
            this._fact(this.text("orderPrice"), fmt.money(of.unitPrice)),
            this._fact(this.text("quantity"), String(l.quantity).replace(".", ",") + " " + (l.uom || "")),
            this._fact(this.text("shipDate"), of.deliveryDate ? fmt.date(of.deliveryDate) : "–"),
            this._fact(this.text("rfqLead"), of.leadDays === null ? "–" : this.text("rfqDays", [of.leadDays]))
          ] }).addStyleClass("sapUiSmallMarginTop"),
          new Text({ text: of.notes || "", visible: !!of.notes }),
          new Button({
            text: bChosen ? this.text("rfqChosen") : this.text("rfqChoose", [this._names[of.cardCode]]),
            type: bChosen ? "Accept" : (i === 0 ? "Emphasized" : "Default"), width: "100%", enabled: !bLocked && !bChosen,
            icon: bChosen ? "sap-icon://accept" : "sap-icon://cart",
            press: function () {
              this._selection[l.key] = of.cardCode;
              oDialog.close();
              this._buildMap();
              this._recalc();
            }.bind(this)
          }).addStyleClass("sapUiSmallMarginTop")
        ] }).addStyleClass("pbOfferCard" + (i === 0 ? " pbOfferTop" : ""))] }));
      }.bind(this));
      oDialog = new Dialog({
        title: this.text("rfqCompareTitle", [l.itemName || l.itemCode]), contentWidth: "40rem", resizable: true, draggable: true,
        subHeader: undefined,
        content: [new VBox({ items: [
          new Text({ text: this.text("rfqCompareSub", [this.text("crit_" + sCrit)]) }).addStyleClass("sapUiSmallMarginBottom"),
          oList
        ] }).addStyleClass("sapUiSmallMargin")],
        endButton: new Button({ text: this.text("cancel"), press: function () { oDialog.close(); } }),
        afterClose: function () { oDialog.destroy(); }
      });
      this.getView().addDependent(oDialog);
      oDialog.open();
    },

    _fact: function (sLabel, sValue) {
      return new VBox({ items: [new Label({ text: sLabel }), new Text({ text: sValue }).addStyleClass("pbFactValue")] }).addStyleClass("pbFact");
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
