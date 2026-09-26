sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  function emptyLine(sDate) {
    return { itemCode: "", itemLabel: "", uom: "", quantity: 1, unitPrice: null, shipDate: sDate, costCenter: "", warehouse: "",
      agreementNo: null, agreementLine: null, agreementOpen: null };
  }

  return BaseController.extend("portal.b1.modules.compras.controller.OrderNew", {
    onInit: function () {
      this.setModel(new JSONModel({ costCenters: [], warehouses: [], whFiltered: [], branches: [], agreements: [], agreementItems: [],
        itemSuggest: [], vendorSuggest: [] }), "md");
      this.setModel(new JSONModel(), "po");
      this.initAttachments();
      this.getRouter().getRoute("compras.orderNew").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      var q = oEvent.getParameter("arguments")["?query"] || {};
      this.resetAttachments();
      var d = new Date(); d.setDate(d.getDate() + 10);
      this._due = this.isoDate(d);
      this.getModel("po").setData({ cardCode: "", cardLabel: "", branch: "", dueDate: this._due, minDate: new Date(), agreementNo: "",
        numAtCard: "", comments: "", lines: [emptyLine(this._due)], total: 0 });
      this.getModel("md").setProperty("/agreements", []);
      var oMd = this.getModel("md");
      Promise.all([
        this.api.get("/api/m/compras/cost-centers"), this.api.get("/api/m/compras/warehouses"), this.api.get("/api/m/compras/branches")
      ]).then(function (a) {
        oMd.setProperty("/costCenters", a[0]);
        oMd.setProperty("/warehouses", a[1]);
        oMd.setProperty("/branches", a[2]);
        if (a[2].length === 1) { this.getModel("po").setProperty("/branch", String(a[2][0].id)); }
        this._filterWarehouses();
      }.bind(this)).catch(function () {});
      // Vindo de um contrato: fornecedor e itens do contrato já preenchidos
      if (q.cardCode) {
        this.api.get("/api/m/compras/vendors?q=" + encodeURIComponent(q.cardCode)).then(function (a) {
          var v = a.filter(function (x) { return x.cardCode === q.cardCode; })[0];
          if (v) { this._setVendor(v, q.agreement); }
        }.bind(this)).catch(function () {});
      }
    },

    // ---------- fornecedor e contrato ----------
    onVendorSuggest: function (oEvent) {
      this.suggest("/api/m/compras/vendors?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/vendorSuggest");
    },

    onVendorSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (oItem) { this._setVendor(oItem.getBindingContext("md").getObject()); }
    },

    onVendorTyped: function () {
      this.getModel("po").setProperty("/cardCode", "");
      this.getModel("md").setProperty("/agreements", []);
      this.getModel("po").setProperty("/agreementNo", "");
    },

    _setVendor: function (v, sAgreement) {
      var oPo = this.getModel("po");
      oPo.setProperty("/cardCode", v.cardCode);
      oPo.setProperty("/cardLabel", v.cardCode + " - " + v.cardName);
      oPo.setProperty("/agreementNo", "");
      this.api.get("/api/m/compras/agreements?active=1&cardCode=" + encodeURIComponent(v.cardCode)).then(function (a) {
        var oMd = this.getModel("md");
        oMd.setProperty("/agreements", a);
        oMd.setProperty("/agreementItems", [{ key: "", text: this.text("orderAgreementNone") }].concat(a.map(function (x) {
          return { key: String(x.agreementNo), text: x.agreementNo + " - " + x.description };
        })));
        if (sAgreement && a.some(function (x) { return String(x.agreementNo) === String(sAgreement); })) {
          oPo.setProperty("/agreementNo", String(sAgreement));
          this.onLoadAgreement();
        } else if (a.length === 1) {
          oPo.setProperty("/agreementNo", String(a[0].agreementNo));
        }
      }.bind(this)).catch(function () {});
    },

    _agreement: function () {
      var sNo = this.getModel("po").getProperty("/agreementNo");
      return (this.getModel("md").getProperty("/agreements") || []).filter(function (x) { return String(x.agreementNo) === String(sNo); })[0] || null;
    },

    onAgreementChange: function () {
      var oAg = this._agreement();
      var oModel = this.getModel("po");
      // Linhas do contrato anterior perdem o vínculo
      oModel.getProperty("/lines").forEach(function (l, i) {
        if (l.agreementNo && (!oAg || String(l.agreementNo) !== String(oAg.agreementNo))) {
          oModel.setProperty("/lines/" + i + "/agreementNo", null);
          oModel.setProperty("/lines/" + i + "/agreementLine", null);
        }
      });
    },

    onLoadAgreement: function () {
      var oAg = this._agreement();
      if (!oAg) { return; }
      var oModel = this.getModel("po");
      var aKeep = oModel.getProperty("/lines").filter(function (l) { return l.itemCode; });
      var aNew = oAg.lines.filter(function (l) { return l.itemCode && l.openQty > 0; }).map(function (l) {
        return Object.assign(emptyLine(this._due), {
          itemCode: l.itemCode, itemLabel: l.itemCode + " - " + l.itemName, uom: l.uom, quantity: 1, unitPrice: l.unitPrice,
          agreementNo: oAg.agreementNo, agreementLine: l.lineNum, agreementOpen: l.openQty
        });
      }.bind(this));
      oModel.setProperty("/lines", aKeep.concat(aNew));
      this.onRecalc();
    },

    // ---------- filial / linhas ----------
    onBranchChange: function () { this._filterWarehouses(); },

    _filterWarehouses: function () {
      var oMd = this.getModel("md");
      var sBranch = this.getModel("po").getProperty("/branch");
      oMd.setProperty("/whFiltered", (oMd.getProperty("/warehouses") || []).filter(function (w) {
        return !sBranch || w.branch === null || w.branch === undefined || String(w.branch) === String(sBranch);
      }));
    },

    onAddLine: function () {
      var oModel = this.getModel("po");
      var a = oModel.getProperty("/lines");
      var oNew = emptyLine(this._due);
      oNew.costCenter = (a[a.length - 1] || {}).costCenter || "";
      oModel.setProperty("/lines", a.concat([oNew]));
    },

    onRemoveLine: function (oEvent) {
      var oModel = this.getModel("po");
      var i = Number(oEvent.getSource().getBindingContext("po").getPath().split("/").pop());
      var a = oModel.getProperty("/lines").slice();
      a.splice(i, 1);
      oModel.setProperty("/lines", a);
      this.onRecalc();
    },

    onRecalc: function () {
      var oModel = this.getModel("po");
      var f = (oModel.getProperty("/lines") || []).reduce(function (s, l) { return s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0); }, 0);
      oModel.setProperty("/total", Math.round(f * 100) / 100);
    },

    onItemSuggest: function (oEvent) {
      this.suggest("/api/m/compras/items?q=" + encodeURIComponent(oEvent.getParameter("suggestValue")), this.getModel("md"), "/itemSuggest");
    },

    onItemSelected: function (oEvent) {
      var oItem = oEvent.getParameter("selectedItem");
      if (!oItem) { return; }
      var oCtx = oEvent.getSource().getBindingContext("po");
      var d = oItem.getBindingContext("md").getObject();
      var oModel = this.getModel("po");
      oModel.setProperty("itemCode", d.itemCode, oCtx);
      oModel.setProperty("itemLabel", d.itemCode + " - " + d.itemName, oCtx);
      oModel.setProperty("uom", d.uom, oCtx);
      var bInBranch = (this.getModel("md").getProperty("/whFiltered") || []).some(function (w) { return w.code === d.defaultWarehouse; });
      if (!oCtx.getProperty("warehouse") && d.defaultWarehouse && bInBranch) { oModel.setProperty("warehouse", d.defaultWarehouse, oCtx); }
      // Item do contrato selecionado: preço e saldo do contrato
      var oAg = this._agreement();
      var oLine = oAg && (oAg.lines || []).filter(function (l) { return l.itemCode === d.itemCode; })[0];
      oModel.setProperty("agreementNo", oLine ? oAg.agreementNo : null, oCtx);
      oModel.setProperty("agreementLine", oLine ? oLine.lineNum : null, oCtx);
      oModel.setProperty("agreementOpen", oLine ? oLine.openQty : null, oCtx);
      if (oLine) { oModel.setProperty("unitPrice", oLine.unitPrice, oCtx); }
      this.onRecalc();
    },

    onItemTyped: function (oEvent) {
      var oCtx = oEvent.getSource().getBindingContext("po");
      ["itemCode", "uom"].forEach(function (k) { this.getModel("po").setProperty(k, "", oCtx); }.bind(this));
      this.getModel("po").setProperty("agreementNo", null, oCtx);
    },

    // ---------- envio ----------
    onSubmit: function () {
      var d = this.getModel("po").getData();
      if (!d.cardCode) { MessageBox.warning(this.text("orderNeedVendor")); return; }
      if (d.lines.some(function (l) { return l.itemLabel && !l.itemCode; })) { MessageBox.warning(this.text("invalidItem")); return; }
      var aLines = d.lines.filter(function (l) { return l.itemCode; });
      if (!aLines.length) { MessageBox.warning(this.text("noLines")); return; }
      if (this.getModel("md").getProperty("/branches").length && !d.branch) { MessageBox.warning(this.text("branchRequired")); return; }
      var oPayload = {
        cardCode: d.cardCode, branch: d.branch || undefined, dueDate: d.dueDate, numAtCard: d.numAtCard, comments: d.comments,
        lines: aLines.map(function (l) {
          return { itemCode: l.itemCode, quantity: l.quantity, unitPrice: l.unitPrice, shipDate: l.shipDate, costCenter: l.costCenter,
            warehouse: l.warehouse, agreementNo: l.agreementNo || undefined, agreementLine: l.agreementNo ? l.agreementLine : undefined };
        })
      };
      this.busy(this.attachmentPayload().then(function (aAtt) {
        oPayload.attachments = aAtt;
        return this.api.post("/api/m/compras/orders", oPayload);
      }.bind(this))).then(function (r) {
        this.toast(this.text(r.source === "draft" ? "orderSubmittedPending" : "orderSubmitted", [r.source === "draft" ? r.entry : r.docNum]));
        this.navToDoc("po", r.source, r.entry, null, true);
      }.bind(this)).catch(function () {});
    }
  });
});
