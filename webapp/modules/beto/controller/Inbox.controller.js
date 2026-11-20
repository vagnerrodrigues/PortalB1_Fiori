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
  var LABEL = { dueDate: ["Entrega", "date"], daysLate: ["Dias de atraso"], total: ["Total", "money"], price: ["Preço", "money"],
    avgPrice: ["Preço médio", "money"], quantity: ["Quantidade"], openQty: ["Em aberto"], itemName: ["Item"] };
  var dt = function (s) { return s ? new Date(s).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "–"; };

  /** BETO — caixa de recomendações (etapa 1). O Beto recomenda; a pessoa decide; as telas do portal executam. */
  return BaseController.extend("portal.b1.modules.beto.controller.Inbox", {
    onInit: function () {
      this.setModel(new JSONModel({ status: "PENDENTE", recs: [], runs: [], skills: [], roles: {}, health: {} }), "beto");
      this.getRouter().getRoute("beto.inbox").attachPatternMatched(this._load, this);
    },

    _m: function () { return this.getModel("beto"); },

    _load: function () {
      if (!this.routeOk()) { return; }
      var m = this._m();
      var st = m.getProperty("/status");
      var fmt = this.formatter;
      this.busy(Promise.all([
        this.api.get("/api/m/beto/recommendations" + (st ? "?status=" + st : "")),
        this.api.get("/api/m/beto/health"),
        this.api.get("/api/m/beto/runs"),
        this.api.get("/api/m/beto/skills")
      ])).then(function (a) {
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

    onRun: function () {
      this.busy(this.api.post("/api/m/beto/runs", {})).then(function (r) {
        MessageToast.show(r.status === "CONCLUIDO" ? r.findings + " achado(s), " + r.newRecs + " recomendação(ões) nova(s)" : "Execução com erros: " + r.errors.join("; "));
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
          new Text({ text: (e.kind || "").toUpperCase() + " nº " + (e.docNum || e.docEntry) + (e.lineNum != null ? " / linha " + (e.lineNum + 1) : "") }),
          new Text({ text: [e.cardCode, v.cardName].filter(Boolean).join(" - ") }),
          new Text({ text: Object.keys(v).filter(function (k) { return k !== "cardName"; }).map(function (k) {
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
        this._load();
      }.bind(this)).catch(function () {});
    }
  });
});
