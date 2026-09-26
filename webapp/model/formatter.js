sap.ui.define([
  "sap/ui/core/format/NumberFormat",
  "sap/ui/core/format/DateFormat",
  "sap/ui/core/library"
], function (NumberFormat, DateFormat, coreLibrary) {
  "use strict";
  var ValueState = coreLibrary.ValueState;
  var oCurrency = NumberFormat.getCurrencyInstance({ currencyCode: false, minFractionDigits: 2, maxFractionDigits: 2 });
  var oDateIn = DateFormat.getDateInstance({ pattern: "yyyy-MM-dd" });
  var oDateOut = DateFormat.getDateInstance({ style: "medium" });

  var oBundle = null;

  return {
    setBundle: function (b) { oBundle = b; },
    money: function (v) {
      return v === null || v === undefined || v === "" ? "" : oCurrency.format(Number(v), "BRL");
    },
    date: function (s) {
      if (!s) { return ""; }
      var d = oDateIn.parse(String(s).slice(0, 10));
      return d ? oDateOut.format(d) : s;
    },
    statusText: function (s) {
      return s && oBundle ? oBundle.getText("status_" + s) : (s || "");
    },
    statusState: function (s) {
      return ({
        OPEN: ValueState.Information, CLOSED: ValueState.Success, GENERATED: ValueState.Success,
        APPROVED: ValueState.Success, PENDING: ValueState.Warning, REJECTED: ValueState.Error,
        CANCELLED: ValueState.Error
      })[s] || ValueState.None;
    },
    bpType: function (s) {
      return s && oBundle ? oBundle.getText("bpType_" + s) : (s || "");
    },
    bpTypeState: function (s) {
      return ({ customer: ValueState.Success, supplier: ValueState.Information, lead: ValueState.Warning })[s] || ValueState.None;
    },
    // Rascunho (ODRF) não tem número próprio: o DocNum é só o próximo da série. Identifica pela chave do esboço.
    docTitle: function (sSource, vDocNum, vEntry) {
      if (!oBundle) { return ""; }
      return sSource === "draft"
        ? oBundle.getText("draftTitle", [vEntry])
        : oBundle.getText("docTitle", [vDocNum]);
    },
    anyTitle: function (sSource, vDocNum, vEntry, sDocType) {
      if (!oBundle) { return ""; }
      if (sDocType === "service") {
        return sSource === "draft" ? oBundle.getText("expDraftTitle", [vEntry]) : oBundle.getText("expDocTitle", [vDocNum]);
      }
      return sSource === "draft" ? oBundle.getText("draftTitle", [vEntry]) : oBundle.getText("docTitle", [vDocNum]);
    },
    cleanComments: function (s) { return String(s || "").replace(/^\[DESPESA\]\s*/, ""); },
    apprTitle: function (sDocType, vEntry) {
      if (!oBundle) { return ""; }
      return oBundle.getText(sDocType === "service" ? "expDraftTitle" : "draftTitle", [vEntry]);
    },
    expTitle: function (sSource, vDocNum, vEntry) {
      if (!oBundle) { return ""; }
      return sSource === "draft" ? oBundle.getText("expDraftTitle", [vEntry]) : oBundle.getText("expDocTitle", [vDocNum]);
    },
    isApprovedDraft: function (sSource, sStatus) {
      return sSource === "draft" && sStatus === "APPROVED";
    }
  };
});
