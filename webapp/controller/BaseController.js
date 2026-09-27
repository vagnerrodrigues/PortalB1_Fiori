sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/core/routing/History",
  "sap/m/MessageBox",
  "sap/m/MessageToast",
  "sap/ui/model/json/JSONModel",
  "../model/api",
  "../model/formatter"
], function (Controller, History, MessageBox, MessageToast, JSONModel, api, formatter) {
  "use strict";

  return Controller.extend("portal.b1.controller.BaseController", {
    formatter: formatter,
    api: api,

    getRouter: function () { return this.getOwnerComponent().getRouter(); },
    getModel: function (sName) { return this.getView().getModel(sName) || this.getOwnerComponent().getModel(sName); },
    setModel: function (oModel, sName) { return this.getView().setModel(oModel, sName); },
    text: function (sKey, aArgs) {
      return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(sKey, aArgs);
    },

    onNavBack: function () {
      if (History.getInstance().getPreviousHash() !== undefined) {
        window.history.go(-1);
      } else {
        this.getRouter().navTo("home", {}, true);
      }
    },

    /** Executa promise com busy indicator na view e trata erro padrão. */
    busy: function (oPromise) {
      var oView = this.getView();
      oView.setBusy(true);
      return oPromise.catch(function (oErr) {
        if (oErr.status !== 401) { MessageBox.error(oErr.message); }
        throw oErr;
      }).finally(function () { oView.setBusy(false); });
    },

    /** Sessão ativa e acesso ao módulo desta tela (evita chamadas antes do guard redirecionar). */
    routeOk: function () {
      var oComp = this.getOwnerComponent();
      if (!this.getModel("session").getProperty("/loggedIn")) { return false; }
      var m = /^portal\.b1\.modules\.([a-z]+)\./.exec(this.getMetadata().getName());
      return !m || oComp.hasModule(m[1]);
    },

    // ---------- Anexos (fragments/AttachmentsPicker + AttachmentsList) ----------
    /** Modelo "att" da tela: arquivos escolhidos, ainda não enviados. */
    initAttachments: function () {
      var ALLOWED = ["pdf", "jpg", "jpeg", "png", "gif", "heic", "webp", "xml", "txt", "doc", "docx", "xls", "xlsx", "csv", "zip"];
      this.setModel(new JSONModel({ files: [], allowed: ALLOWED }), "att");
    },

    resetAttachments: function () { this.getModel("att").setProperty("/files", []); },

    onAttachmentPick: function (oEvent) {
      var oModel = this.getModel("att");
      var aPicked = Array.prototype.slice.call(oEvent.getParameter("files") || []);
      var aFiles = oModel.getProperty("/files").slice();
      var that = this;
      aPicked.forEach(function (f) {
        if (aFiles.length >= 5) { that.toast(that.text("attMax")); return; }
        if (f.size > 10 * 1024 * 1024) { that.toast(that.text("attTooBig", [f.name])); return; }
        aFiles.push({ name: f.name, size: f.size, sizeText: Math.max(1, Math.round(f.size / 1024)) + " KB", file: f, idx: aFiles.length });
      });
      oModel.setProperty("/files", aFiles);
      oEvent.getSource().clear();
    },

    onAttachmentType: function () { this.toast(this.text("attType")); },

    onAttachmentRemove: function (oEvent) {
      var oModel = this.getModel("att");
      var iIdx = Number(oEvent.getParameter("listItem").getBindingContext("att").getProperty("idx"));
      var aFiles = oModel.getProperty("/files").filter(function (f) { return f.idx !== iIdx; })
        .map(function (f, i) { return Object.assign({}, f, { idx: i }); });
      oModel.setProperty("/files", aFiles);
    },

    /** Lê os arquivos escolhidos como base64 para enviar junto com o documento. */
    attachmentPayload: function () {
      var aFiles = this.getModel("att").getProperty("/files");
      return Promise.all(aFiles.map(function (f) {
        return new Promise(function (resolve, reject) {
          var r = new FileReader();
          r.onload = function () { resolve({ name: f.name, data: String(r.result).split(",")[1] }); };
          r.onerror = reject;
          r.readAsDataURL(f.file);
        });
      }));
    },

    /** Abre/baixa o anexo gravado no B1 (URL base definida pela tela em doc>/attachmentBase). */
    onAttachmentOpen: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("doc").getObject();
      var sBase = this.getModel("doc").getProperty("/attachmentBase");
      window.open(sBase + "/" + o.line, "_blank", "noopener");
    },

    toast: function (sMsg) { MessageToast.show(sMsg); },

    // ---------- Compras: navegação e buscas compartilhadas ----------
    KIND_SLUG: { pr: "solicitacao", pq: "oferta", po: "pedido", gr: "recebimento" },
    SLUG_KIND: { solicitacao: "pr", oferta: "pq", pedido: "po", recebimento: "gr" },

    /** Abre o detalhe de um documento de compras (solicitação, oferta ou pedido). */
    navToDoc: function (sKind, sSource, vEntry, oQuery, bReplace) {
      var oArgs = { kind: this.KIND_SLUG[sKind] || "solicitacao", source: sSource, entry: vEntry };
      if (oQuery) { oArgs["?query"] = oQuery; }
      this.getRouter().navTo("compras.detail", oArgs, bReplace);
    },

    /** Busca com atraso (digitação) e grava o resultado em oModel>sPath. */
    suggest: function (sUrl, oModel, sPath) {
      this._suggestTimers = this._suggestTimers || {};
      clearTimeout(this._suggestTimers[sPath]);
      this._suggestTimers[sPath] = setTimeout(function () {
        api.get(sUrl).then(function (a) { oModel.setProperty(sPath, a); }).catch(function () {});
      }, 250);
    },

    isoDate: function (d) {
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    },

    copyText: function (sText) {
      var fnFallback = function () {
        var el = document.createElement("textarea");
        el.value = sText;
        document.body.appendChild(el);
        el.select();
        try { document.execCommand("copy"); } catch (e) { /* sem suporte */ }
        document.body.removeChild(el);
        return Promise.resolve();
      };
      return (navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(sText) : fnFallback())
        .catch(fnFallback);
    },

    onLogout: function () {
      api.post("/api/logout").finally(function () {
        this.getModel("session").setProperty("/loggedIn", false);
        this.getRouter().navTo("login", {}, true);
      }.bind(this));
    }
  });
});
