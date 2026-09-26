sap.ui.define([
  "portal/b1/controller/BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox"
], function (BaseController, JSONModel, MessageBox) {
  "use strict";

  var UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];

  function empty() {
    return {
      taxId: "", taxIdState: "None", taxIdStateText: "", lookupMsg: "", lookupType: "Information", situation: "",
      name: "", tradeName: "", stateRegistration: "", phone: "", email: "", notes: "",
      address: { zipCode: "", street: "", streetNo: "", complement: "", block: "", city: "", state: "" },
      contact: { name: "", phone: "", email: "" },
      ufs: UFS
    };
  }

  return BaseController.extend("portal.b1.modules.parceiros.controller.New", {
    onInit: function () {
      this.setModel(new JSONModel(empty()), "lead");
      this.getRouter().getRoute("parceiros.new").attachPatternMatched(function () {
        this.getModel("lead").setData(empty());
        this._lastDoc = null;
        this._lastCep = null;
      }, this);
    },

    // Busca automática: assim que o CNPJ (14 dígitos) ou CPF (11) estiver completo, consulta sozinho
    onTaxIdChange: function (oEvent) {
      var oModel = this.getModel("lead");
      oModel.setProperty("/lookupMsg", "");
      oModel.setProperty("/situation", "");
      oModel.setProperty("/taxIdState", "None");
      var sDigits = String(oEvent.getParameter("value") || "").replace(/\D/g, "");
      clearTimeout(this._tDoc);
      if ((sDigits.length === 14 || sDigits.length === 11) && sDigits !== this._lastDoc) {
        this._tDoc = setTimeout(function () {
          oModel.setProperty("/taxId", sDigits);
          this.onLookup();
        }.bind(this), 400);
      }
    },

    // CEP completo -> preenche logradouro, bairro, cidade e UF (tudo continua editável)
    onZipChange: function (oEvent) {
      var sCep = String(oEvent.getParameter("value") || "").replace(/\D/g, "");
      if (sCep.length !== 8 || sCep === this._lastCep) { return; }
      this._lastCep = sCep;
      var oModel = this.getModel("lead");
      this.api.get("/api/m/parceiros/cep/" + sCep).then(function (oRes) {
        if (!oRes.data) { return; }
        var a = oModel.getProperty("/address");
        oModel.setProperty("/address", Object.assign({}, a, {
          zipCode: oRes.data.zipCode, street: oRes.data.street || a.street, block: oRes.data.block || a.block,
          city: oRes.data.city || a.city, state: oRes.data.state || a.state
        }));
      }).catch(function () {});
    },

    // Consulta CNPJ: dados da Receita + verifica se já existe no B1
    onLookup: function () {
      var oModel = this.getModel("lead");
      var sDoc = (oModel.getProperty("/taxId") || "").replace(/\D/g, "");
      this._lastDoc = sDoc;
      if (sDoc.length !== 14 && sDoc.length !== 11) {
        oModel.setProperty("/taxIdState", "Error");
        oModel.setProperty("/taxIdStateText", this.text("bpTaxId"));
        return;
      }
      this.busy(this.api.get("/api/m/parceiros/cnpj/" + sDoc)).then(function (oRes) {
        oModel.setProperty("/taxIdState", "None");
        if (oRes.existing && oRes.existing.length) {
          oModel.setProperty("/lookupType", "Warning");
          oModel.setProperty("/lookupMsg", this.text("bpExists", [oRes.existing[0].cardCode, oRes.existing[0].cardName]));
          return;
        }
        var sDupNote = oRes.duplicateCheck === false ? " " + this.text("bpDupUnchecked") : "";
        if (oRes.data) {
          var d = oRes.data;
          oModel.setProperty("/taxId", d.taxId);
          oModel.setProperty("/name", d.name);
          oModel.setProperty("/tradeName", d.tradeName);
          oModel.setProperty("/phone", d.phone);
          oModel.setProperty("/email", d.email);
          oModel.setProperty("/situation", d.status);
          oModel.setProperty("/address", Object.assign(oModel.getProperty("/address"), d.address));
          oModel.setProperty("/lookupType", d.status && d.status !== "ATIVA" ? "Warning" : "Success");
          oModel.setProperty("/lookupMsg", this.text("bpLookupOk") + sDupNote);
          this._lastCep = String(d.address && d.address.zipCode || "").replace(/\D/g, "");
        } else {
          oModel.setProperty("/lookupType", "Information");
          oModel.setProperty("/lookupType", oRes.lookupError ? "Warning" : "Information");
          oModel.setProperty("/lookupMsg", (oRes.lookupError || this.text("bpLookupHint")) + sDupNote);
        }
      }.bind(this)).catch(function (oErr) {
        oModel.setProperty("/taxIdState", "Error");
        oModel.setProperty("/taxIdStateText", oErr.message);
      });
    },

    onSave: function () {
      var d = this.getModel("lead").getData();
      var oPayload = {
        taxId: d.taxId, name: d.name, tradeName: d.tradeName, stateRegistration: d.stateRegistration,
        phone: d.phone, email: d.email, notes: d.notes, address: d.address, contact: d.contact
      };
      this.busy(this.api.post("/api/m/parceiros", oPayload)).then(function (oRes) {
        MessageBox.success(this.text("bpCreated", [oRes.cardCode]), {
          onClose: function () { this.getRouter().navTo("parceiros.detail", { cardCode: oRes.cardCode }, true); }.bind(this)
        });
      }.bind(this)).catch(function () {});
    }
  });
});
