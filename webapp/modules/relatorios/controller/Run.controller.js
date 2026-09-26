sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/Text",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/DatePicker",
  "sap/m/VBox",
  "sap/ui/core/format/NumberFormat",
  "sap/ui/core/format/DateFormat"
], function (BaseController, JSONModel, Column, ColumnListItem, Text, Label, Input, DatePicker, VBox, NumberFormat, DateFormat) {
  "use strict";

  var oMoney = NumberFormat.getFloatInstance({ minFractionDigits: 2, maxFractionDigits: 2, groupingEnabled: true });
  var oNumber = NumberFormat.getFloatInstance({ maxFractionDigits: 3, groupingEnabled: true });
  var oDateIn = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd" });
  var oDateOut = DateFormat.getDateInstance({ pattern: "dd/MM/yyyy" });

  function iso(d) { return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function defaultValue(s) {
    var d = new Date();
    if (s === "today") { return iso(d); }
    if (s === "monthStart") { return iso(new Date(d.getFullYear(), d.getMonth(), 1)); }
    if (s === "yearStart") { return iso(new Date(d.getFullYear(), 0, 1)); }
    return s || "";
  }
  function fmt(v, sType) {
    if (v === null || v === undefined || v === "") { return ""; }
    if (sType === "money") { return oMoney.format(Number(v)); }
    if (sType === "number") { return oNumber.format(Number(v)); }
    if (sType === "date") { var d = oDateIn.parse(String(v).slice(0, 10)); return d ? oDateOut.format(d) : String(v); }
    return String(v);
  }

  return BaseController.extend("portal.b1.modules.relatorios.controller.Run", {
    onInit: function () {
      this.setModel(new JSONModel({ report: {}, params: {}, rows: [], ran: false }), "run");
      this.getRouter().getRoute("relatorios.run").attachPatternMatched(this._onMatched, this);
    },

    _onMatched: function (oEvent) {
      if (!this.routeOk()) { return; }
      var sId = oEvent.getParameter("arguments").id;
      var oCatalog = this.getModel("session").getProperty("/reportCatalog");
      var pCatalog = oCatalog ? Promise.resolve(oCatalog) : this.api.get("/api/m/relatorios");
      this.busy(pCatalog).then(function (a) {
        var oRep = a.filter(function (r) { return r.id === sId; })[0];
        if (!oRep) { this.getRouter().navTo("relatorios.list", {}, true); return; }
        this._setup(oRep);
        if (!oRep.params.length) { this.onRun(); }
      }.bind(this)).catch(function () {});
    },

    _setup: function (oRep) {
      var oModel = this.getModel("run");
      var oParams = {};
      oRep.params.forEach(function (p) { oParams[p.name] = defaultValue(p.default); });
      oModel.setData({ report: oRep, params: oParams, rows: [], ran: false, info: "" });

      var oBox = this.byId("params");
      oBox.destroyItems();
      if (!oRep.params.length) {
        oBox.addItem(new Text({ text: this.text("repNoParams") }));
      }
      oRep.params.forEach(function (p) {
        var oField = p.type === "date"
          ? new DatePicker({ value: "{run>/params/" + p.name + "}", valueFormat: "yyyy-MM-dd", displayFormat: "dd/MM/yyyy", width: "11rem" })
          : new Input({ value: "{run>/params/" + p.name + "}", width: "14rem", submit: this.onRun.bind(this) });
        oBox.addItem(new VBox({ items: [new Label({ text: p.label, labelFor: oField }), oField] }).addStyleClass("sapUiSmallMarginEnd"));
      }.bind(this));

      var oTable = this.byId("result");
      oTable.unbindItems();
      oTable.destroyColumns();
    },

    onRun: function () {
      var oModel = this.getModel("run");
      var sId = oModel.getProperty("/report/id");
      this.busy(this.api.post("/api/m/relatorios/" + sId + "/run", { params: oModel.getProperty("/params") })).then(function (oRes) {
        this._render(oRes);
      }.bind(this)).catch(function () {});
    },

    _render: function (oRes) {
      var oModel = this.getModel("run");
      var aCols = oRes.columns;
      // chaves neutras (c0..cn): nomes de coluna do SQL podem ter espaços/acentos
      var aRows = oRes.rows.map(function (r) {
        var o = {};
        aCols.forEach(function (c, i) { o["c" + i] = r[c.key]; });
        return o;
      });
      oModel.setProperty("/rows", aRows);
      oModel.setProperty("/columns", aCols);
      oModel.setProperty("/truncated", oRes.truncated);
      oModel.setProperty("/ran", true);
      oModel.setProperty("/info", this.text("repRows", [aRows.length, oRes.ms]));

      var oTable = this.byId("result");
      oTable.unbindItems();
      oTable.destroyColumns();
      var aCells = [];
      aCols.forEach(function (c, i) {
        var bNum = c.type === "money" || c.type === "number";
        var oFooter = null;
        if (c.sum) {
          var fSum = aRows.reduce(function (s, r) { return s + (Number(r["c" + i]) || 0); }, 0);
          oFooter = new Text({ text: fmt(fSum, c.type) }).addStyleClass("sapUiTinyMarginTop pcTotal");
        }
        oTable.addColumn(new Column({
          header: new Text({ text: c.label }),
          hAlign: bNum ? "End" : "Begin",
          minScreenWidth: i > 2 ? "Tablet" : undefined,
          demandPopin: i > 2,
          footer: oFooter
        }));
        aCells.push(new Text({ text: { path: "run>c" + i, formatter: function (v) { return fmt(v, c.type); } } }));
      });
      oTable.bindItems({ path: "run>/rows", template: new ColumnListItem({ cells: aCells }), templateShareable: false });
    },

    // CSV no padrão do Excel pt-BR: separador ";", decimal ",", UTF-8 com BOM
    onExport: function () {
      var oModel = this.getModel("run");
      var aCols = oModel.getProperty("/columns");
      var aRows = oModel.getProperty("/rows");
      var esc = function (v) {
        var s = v === null || v === undefined ? "" : String(v);
        return /[";\n]/.test(s) ? "\"" + s.replace(/"/g, "\"\"") + "\"" : s;
      };
      var cell = function (v, t) {
        if (v === null || v === undefined) { return ""; }
        if (t === "money" || t === "number") { return String(v).replace(".", ","); }
        if (t === "date") { return fmt(v, "date"); }
        return v;
      };
      var aLines = [aCols.map(function (c) { return esc(c.label); }).join(";")];
      aRows.forEach(function (r) {
        aLines.push(aCols.map(function (c, i) { return esc(cell(r["c" + i], c.type)); }).join(";"));
      });
      var oBlob = new Blob(["﻿" + aLines.join("\r\n")], { type: "text/csv;charset=utf-8" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(oBlob);
      a.download = oModel.getProperty("/report/id") + "-" + iso(new Date()) + ".csv";
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }
  });
});
