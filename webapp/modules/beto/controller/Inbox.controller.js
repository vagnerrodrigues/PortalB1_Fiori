sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/VBox",
  "sap/m/HBox",
  "sap/m/Text",
  "sap/m/Title",
  "sap/m/Label",
  "sap/m/TextArea",
  "sap/m/DatePicker",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/ObjectStatus",
  "sap/m/MessageToast"
], function (BaseController, JSONModel, Dialog, Button, VBox, HBox, Text, Title, Label, TextArea, DatePicker, Table, Column, ColumnListItem,
  ObjectStatus, MessageToast) {
  "use strict";

  var SEV = { alta: ["Alta", "Error"], media: ["Média", "Warning"], baixa: ["Baixa", "Information"] };
  var ST = { PENDENTE: ["Pendente", "Warning"], ACEITA: ["Aceita", "Success"], REJEITADA: ["Rejeitada", "None"], ADIADA: ["Adiada", "Information"],
    RESOLVIDA: ["Resolvida", "Success"], EXPIRADA: ["Expirada", "None"] };
  // Rótulos dos valores das evidências (as skills gravam em chaves técnicas)
  var LABEL = { dueDate: ["Entrega", "date"], daysLate: ["Dias de atraso"], total: ["Total", "money"], price: ["Preço", "money"], openValue: ["Em aberto", "money"],
    openLines: ["Linhas abertas"], cardName: ["Fornecedor"],
    avgPrice: ["Preço médio", "money"], quantity: ["Quantidade"], openQty: ["Em aberto"], itemName: ["Item"] };
  var dt = function (s) { return s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "–"; };

  /** BETO — caixa de recomendações (etapa 1). O Beto recomenda; a pessoa decide; as telas do portal executam. */
  return BaseController.extend("portal.b1.modules.beto.controller.Inbox", {
    onInit: function () {
      this.setModel(new JSONModel({ status: "PENDENTE", recs: [], runs: [], skills: [], roles: {}, health: {}, conn: { userName: "", password: "", tables: [] }, wh: [] }), "beto");
      this.getRouter().getRoute("beto.inbox").attachPatternMatched(this._load, this);
    },

    _m: function () { return this.getModel("beto"); },

    _load: function (bQuiet) {
      if (!this.routeOk()) { return; }
      var m = this._m();
      var st = m.getProperty("/status");
      var fmt = this.formatter;
      var p = Promise.all([
        this.api.get("/api/m/beto/recommendations" + (st ? "?status=" + st : "")),
        this.api.get("/api/m/beto/health"),
        this.api.get("/api/m/beto/runs"),
        this.api.get("/api/m/beto/skills")
      ]);
      (bQuiet ? p : this.busy(p)).then(function (a) {
        m.setProperty("/roles", a[0].roles);
        m.setProperty("/recs", a[0].items.map(function (r) {
          var sev = SEV[r.severity] || [r.severity, "None"];
          var s = ST[r.status] || [r.status, "None"];
          return Object.assign({}, r, {
            severityText: sev[0], severityState: sev[1], statusText: s[0], statusState: s[1],
            impactText: r.impactBRL ? fmt.money(r.impactBRL) : "",
            meta: r.evidenceCount + " documento(s) · " + r.skill + " · " + dt(r.createdAt) + (r.snoozeUntil ? " · adiada até " + fmt.date(r.snoozeUntil) : "")
          });
        }));
        m.setProperty("/health", a[1]);
        var conn = (a[1].sap && a[1].sap.connection) || {};
        m.setProperty("/conn/userName", m.getProperty("/conn/userName") || conn.userName || "manager");
        m.setProperty("/conn/configured", !!conn.configured);
        m.setProperty("/conn/info", conn.configured ? "Usuário " + conn.userName + " · salvo por " + (conn.updatedBy || "?") + " em " + dt(conn.updatedAt) : "Não configurada");
        m.setProperty("/conn/tables", ((conn.lastTest && conn.lastTest.tables) || []).map(function (x) {
          return { tables: x.tables, how: x.sql ? "SQL (rápido)" : x.odata ? "OData (mais lento; libere no b1s_sqltable.conf)" : "Sem acesso", state: x.sql ? "Success" : x.odata ? "Warning" : "Error" };
        }));
        m.setProperty("/conn/testText", conn.lastTest ? (conn.lastTest.ok ? "Último teste OK em " : "Último teste FALHOU em ") + dt(conn.lastTest.at) + (conn.lastTest.error ? " · " + conn.lastTest.error : "") : "");
        var NAMES = { po: "Pedidos de compra (linhas)", vendor: "Fornecedores", item: "Itens de compra" };
        m.setProperty("/wh", ((a[1].sap && a[1].sap.warehouse) || []).map(function (w) {
          return { name: NAMES[w.entity] || w.entity, total: w.total, rows: w.rows, mode: w.mode === "sql" ? "SQL" : w.mode === "odata" ? "OData" : w.mode === "demo" ? "Demonstração" : "–",
            last: dt(w.lastRun), ms: w.ms, ok: w.ok, error: w.error || "", watermark: w.watermark ? fmt.date(w.watermark) : "–" };
        }));
        this._poll(a[1].running);
        m.setProperty("/lastRunText", a[1].lastRun ? dt(a[1].lastRun.endedAt || a[1].lastRun.startedAt) + " · " + a[1].lastRun.status : "Nunca executado");
        m.setProperty("/runs", a[2].map(function (r) {
          return Object.assign({}, r, { startedText: dt(r.startedAt), stepsText: r.steps.map(function (s) { return s.step + " (" + s.rows + ", " + s.ms + " ms" + (s.error ? ", " + s.error : "") + ")"; }).join(" · ") });
        }));
        m.setProperty("/skills", a[3].map(function (s) {
          return Object.assign({}, s, { meta: (s.financialImpact ? "Impacto financeiro · " : "") + "Público: " + s.audience + (s.mockOnly ? " · somente demonstração" : "") });
        }));
      }.bind(this)).catch(function () {});
    },

    onRefresh: function () { this._load(); },
    onStatus: function () { this._load(); },

    onRun: function () { this._start("/api/m/beto/runs"); },
    onSync: function () { this._start("/api/m/beto/sync"); },

    /** Execução/sincronização: no SAP real roda em segundo plano (202) e a tela acompanha. */
    _start: function (url) {
      this.busy(this.api.post(url, {})).then(function (r) {
        if (r.status === "EXECUTANDO") { MessageToast.show("Em execução. A tela atualiza sozinha."); this._load(); return; }
        MessageToast.show(r.status === "CONCLUIDO" ? (r.findings || 0) + " achado(s), " + (r.newRecs || 0) + " recomendação(ões) nova(s)" : "Concluído com avisos: " + (r.errors || []).join("; "));
        this._load();
      }.bind(this)).catch(function () {});
    },

    _poll: function (running) {
      clearTimeout(this._timer);
      if (running) { this._timer = setTimeout(this._load.bind(this, true), 5000); }
    },

    onSaveConn: function () {
      var m = this._m();
      this.busy(this.api.put("/api/m/beto/connection", { userName: m.getProperty("/conn/userName"), password: m.getProperty("/conn/password") })).then(function (c) {
        m.setProperty("/conn/password", "");
        MessageToast.show(c.test && c.test.ok ? "Conexão salva e testada" : "Conexão salva, mas há tabelas sem acesso");
        this._load();
      }.bind(this)).catch(function () {});
    },

    onTestConn: function () {
      this.busy(this.api.post("/api/m/beto/connection/test", {})).then(function (t) {
        MessageToast.show(t.ok ? "Conexão OK" : "Falhou: " + (t.error || "tabelas sem acesso"));
        this._load();
      }.bind(this)).catch(function () {});
    },

    onSkillToggle: function (oEvent) {
      var o = oEvent.getSource().getBindingContext("beto").getObject();
      this.busy(this.api.put("/api/m/beto/skills/" + encodeURIComponent(o.id), { enabled: oEvent.getParameter("state"), params: {} }))
        .then(this._load.bind(this)).catch(this._load.bind(this));
    },

    onOpen: function (oEvent) {
      var id = oEvent.getSource().getBindingContext("beto").getProperty("id");
      this.busy(this.api.get("/api/m/beto/recommendations/" + id)).then(this._detail.bind(this)).catch(function () {});
    },

    _detail: function (r) {
      var fmt = this.formatter;
      var canDecide = this._m().getProperty("/roles/decider") && (r.status === "PENDENTE" || r.status === "ADIADA");
      var ev = new Table({ growing: true, growingThreshold: 20, columns: [
        new Column({ header: new Text({ text: "Documento" }) }), new Column({ header: new Text({ text: "Parceiro" }) }),
        new Column({ header: new Text({ text: "Detalhes" }), minScreenWidth: "Tablet", demandPopin: true })
      ] });
      r.evidence.forEach(function (e) {
        var v = e.values || {};
        ev.addItem(new ColumnListItem({ cells: [
          new Text({ text: e.kind === "vendor" ? "Fornecedor" : e.kind === "item" ? "Item " + e.itemCode
            : "Pedido nº " + (e.docNum || e.docEntry) + (e.lineNum != null ? " / linha " + (e.lineNum + 1) : "") + (e.itemCode ? " · " + e.itemCode : "") }),
          new Text({ text: [e.cardCode, v.cardName].filter(Boolean).join(" - ") }),
          new Text({ text: Object.keys(v).filter(function (k) { return k !== "cardName" && v[k] != null && v[k] !== ""; }).map(function (k) {
            var l = LABEL[k] || [k];
            var val = l[1] === "money" ? fmt.money(v[k]) : l[1] === "date" ? fmt.date(v[k]) : v[k];
            return l[0] + ": " + val;
          }).join(" · ") })
        ] }));
      });
      var hist = new VBox({ items: r.history.map(function (h) { return new Text({ text: dt(h.at) + " · " + h.action + (h.actor ? " · " + h.actor : "") }).addStyleClass("pbMuted pbSmall"); }) });
      var dlg = new Dialog({
        title: r.title, contentWidth: "52rem", resizable: true, draggable: true,
        content: [new VBox({ items: [
          new HBox({ wrap: "Wrap", items: [
            new ObjectStatus({ text: (SEV[r.severity] || [r.severity])[0], state: (SEV[r.severity] || [0, "None"])[1], inverted: true }).addStyleClass("sapUiTinyMarginEnd"),
            new ObjectStatus({ text: (ST[r.status] || [r.status])[0], state: (ST[r.status] || [0, "None"])[1] }).addStyleClass("sapUiTinyMarginEnd"),
            new Text({ text: r.impactBRL ? "Impacto: " + fmt.money(r.impactBRL) : "" })
          ] }),
          new Text({ text: r.explanation }).addStyleClass("sapUiSmallMarginTop"),
          new Text({ text: "Skill " + r.skill + " v" + (r.finding && r.finding.skillVersion) + " · visto pela 1ª vez em " + dt(r.finding && r.finding.firstSeen) + " · última análise " + dt(r.finding && r.finding.lastSeen) }).addStyleClass("pbMuted pbSmall sapUiTinyMarginTop"),
          new Title({ text: "Evidências (" + r.evidenceCount + ")", level: "H3" }).addStyleClass("sapUiSmallMarginTop"), ev,
          new Title({ text: "Histórico", level: "H3" }).addStyleClass("sapUiSmallMarginTop"), hist
        ] }).addStyleClass("sapUiSmallMargin")],
        buttons: (canDecide ? [
          new Button({ text: "Aceitar e abrir", type: "Emphasized", press: function () { this._decide(dlg, r, "ACEITA"); }.bind(this) }),
          new Button({ text: "Adiar", press: function () { this._ask(dlg, r, "ADIADA"); }.bind(this) }),
          new Button({ text: "Rejeitar", type: "Reject", press: function () { this._ask(dlg, r, "REJEITADA"); }.bind(this) })
        ] : []).concat([new Button({ text: "Fechar", press: function () { dlg.close(); } })]),
        afterClose: function () { dlg.destroy(); }
      });
      this.getView().addDependent(dlg);
      dlg.open();
    },

    _ask: function (parent, r, decision) {
      var reason = new TextArea({ width: "100%", rows: 3, maxLength: 500, placeholder: "Motivo (obrigatório)" });
      var until = new DatePicker({ width: "100%", valueFormat: "yyyy-MM-dd", displayFormat: "dd/MM/yyyy", minDate: new Date(Date.now() + 864e5), visible: decision === "ADIADA" });
      var ask = new Dialog({
        title: decision === "ADIADA" ? "Adiar recomendação" : "Rejeitar recomendação", contentWidth: "26rem",
        content: [new VBox({ items: [new Label({ text: "Motivo", required: true, labelFor: reason }), reason,
          new Label({ text: "Adiar até", required: true, labelFor: until, visible: decision === "ADIADA" }), until] }).addStyleClass("sapUiSmallMargin")],
        beginButton: new Button({ text: "Confirmar", type: "Emphasized", press: function () {
          this._decide(parent, r, decision, reason.getValue(), until.getValue(), ask);
        }.bind(this) }),
        endButton: new Button({ text: "Cancelar", press: function () { ask.close(); } }),
        afterClose: function () { ask.destroy(); }
      });
      this.getView().addDependent(ask);
      ask.open();
    },

    _decide: function (dlg, r, decision, reason, snoozeUntil, ask) {
      this.busy(this.api.post("/api/m/beto/recommendations/" + r.id + "/decision", { decision: decision, reason: reason, snoozeUntil: snoozeUntil })).then(function (out) {
        if (ask) { ask.close(); }
        dlg.close();
        MessageToast.show("Decisão registrada: " + (ST[out.status] || [out.status])[0]);
        // Aceitar: o Beto não executa nada; abre a tela existente para a pessoa agir
        if (out.action && out.action.route) { this.getRouter().navTo(out.action.route, out.action.params || {}); return; }
        if (out.action && out.action.label) { MessageToast.show("Próximo passo: " + out.action.label); }
        this._load();
      }.bind(this)).catch(function () {});
    }
  });
});
