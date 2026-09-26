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
    },

    // ---------- Compras: solicitação (pr), oferta (pq), pedido (po) ----------
    kindName: function (sKind) {
      return oBundle ? oBundle.getText("kind_" + (sKind || "pr")) : "";
    },
    /** Título de qualquer documento de compras; despesa (serviço) mantém o título próprio. */
    kindTitle: function (sKind, sSource, vDocNum, vEntry, sDocType) {
      if (!oBundle) { return ""; }
      if (sDocType === "service") {
        return sSource === "draft" ? oBundle.getText("expDraftTitle", [vEntry]) : oBundle.getText("expDocTitle", [vDocNum]);
      }
      var sName = oBundle.getText("kind_" + (sKind || "pr"));
      return sSource === "draft" ? oBundle.getText("kindDraftTitle", [sName, vEntry]) : oBundle.getText("kindDocTitle", [sName, vDocNum]);
    },
    apprKindTitle: function (sKind, sDocType, vEntry) {
      if (!oBundle) { return ""; }
      if (sDocType === "service") { return oBundle.getText("expDraftTitle", [vEntry]); }
      return oBundle.getText("kindDraftTitle", [oBundle.getText("kind_" + (sKind || "pr")), vEntry]);
    },
    docStatusText: function (sKind, sStatus) {
      if (!oBundle || !sStatus) { return sStatus || ""; }
      var sPrefix = sKind === "po" ? "statusPo_" : sKind === "pq" ? "statusPq_" : "status_";
      var sKey = sPrefix + sStatus;
      return oBundle.hasText(sKey) ? oBundle.getText(sKey) : oBundle.getText("status_" + sStatus);
    },
    /** Texto i18n com parâmetros: parts [{value: 'chave'}, 'modelo>campo', ...]. Vazio se o 1º parâmetro for vazio. */
    txt: function (sKey) {
      var aArgs = Array.prototype.slice.call(arguments, 1);
      if (!oBundle || aArgs[0] === undefined || aArgs[0] === null || aArgs[0] === "" || aArgs[0] === 0) { return ""; }
      return oBundle.getText(sKey, aArgs);
    },
    prefixed: function (sPrefix, s) {
      return s && oBundle ? oBundle.getText(sPrefix + s) : (s || "");
    },
    rfqState: function (s) {
      return ({ OPEN: ValueState.Information, EXPIRED: ValueState.Warning, CLOSED: ValueState.None,
        AWARDED: ValueState.Success, CANCELLED: ValueState.Error })[s] || ValueState.None;
    },
    supplierState: function (s) {
      return ({ INVITED: ValueState.None, VIEWED: ValueState.Information, ANSWERED: ValueState.Success,
        DECLINED: ValueState.Warning, ERROR: ValueState.Error })[s] || ValueState.None;
    },
    syncState: function (s) {
      return ({ PENDING: ValueState.Warning, SYNCED: ValueState.Success, ERROR: ValueState.Error })[s] || ValueState.None;
    },
    agState: function (s) {
      return ({ ACTIVE: ValueState.Success, ONHOLD: ValueState.Warning, DRAFT: ValueState.Information,
        TERMINATED: ValueState.None, CANCELLED: ValueState.Error })[s] || ValueState.None;
    },
    /** Consumo do contrato: até 80% ok, até 100% atenção, acima disso crítico. */
    consumptionState: function (v) {
      var n = Number(v) || 0;
      return n > 100 ? ValueState.Error : n >= 80 ? ValueState.Warning : ValueState.Success;
    },
    pct: function (v) {
      return v === null || v === undefined ? "" : String(Math.round(Number(v) * 10) / 10).replace(".", ",") + "%";
    },
    pctValue: function (v) { return Math.min(Number(v) || 0, 100); },
    period: function (a, b) {
      if (!oBundle) { return ""; }
      var f = function (s) {
        var d = s ? oDateIn.parse(String(s).slice(0, 10)) : null;
        return d ? oDateOut.format(d) : "";
      };
      return oBundle.getText("contractPeriod", [f(a), f(b)]);
    }
  };
});
