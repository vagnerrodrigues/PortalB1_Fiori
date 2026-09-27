sap.ui.define([
  "./BaseController",
  "sap/m/Title",
  "sap/m/FlexBox",
  "sap/m/GenericTile",
  "sap/m/TileContent",
  "sap/m/NumericContent",
  "sap/m/ImageContent",
  "sap/m/VBox",
  "sap/m/HBox",
  "sap/m/Text",
  "sap/m/Label",
  "sap/m/ObjectNumber",
  "sap/m/ObjectStatus",
  "sap/m/ProgressIndicator",
  "sap/m/SegmentedButton",
  "sap/m/SegmentedButtonItem",
  "sap/m/Button",
  "sap/ui/core/HTML"
], function (BaseController, Title, FlexBox, GenericTile, TileContent, NumericContent, ImageContent,
  VBox, HBox, Text, Label, ObjectNumber, ObjectStatus, ProgressIndicator, SegmentedButton, SegmentedButtonItem, Button, HTML) {
  "use strict";

  // Launchpad: um grupo de tiles por módulo liberado para o usuário (vem de /api/me)
  return BaseController.extend("portal.b1.controller.Home", {
    onInit: function () {
      this.getRouter().getRoute("home").attachPatternMatched(this._render, this);
    },

    _render: function () {
      var oSession = this.getModel("session");
      if (!oSession.getProperty("/loggedIn")) { return; }
      var oBox = this.byId("modules");
      oBox.destroyItems();
      this._counters = {};
      this._renderHeader();

      (oSession.getProperty("/modules") || []).forEach(function (oModule) {
        oBox.addItem(new Title({ text: oModule.title, level: "H2", titleStyle: "H4" }).addStyleClass("sapUiSmallMarginBottom pbModuleTitle"));
        var oRow = new FlexBox({ wrap: "Wrap" }).addStyleClass("pcTiles sapUiMediumMarginBottom");
        oModule.tiles.forEach(function (oTile) {
          var oContent = oTile.counter
            ? new NumericContent({ value: "", icon: oTile.icon, withMargin: false })
            : new ImageContent({ src: oTile.icon });
          var oGT = new GenericTile({
            header: oTile.title,
            state: oTile.counter ? "Loading" : "Loaded",
            subheader: oTile.subtitle,
            press: this.getRouter().navTo.bind(this.getRouter(), oTile.route, {}),
            tileContent: [new TileContent({ content: oContent })]
          });
          if (oTile.counter) { this._counters[oModule.id + "." + oTile.id] = { control: oContent, tile: oGT, critical: oTile.critical }; }
          oRow.addItem(oGT);
        }.bind(this));
        oBox.addItem(oRow);

        if (oModule.tiles.some(function (t) { return t.counter; })) {
          var p = this._loadCounters(oModule.id);
          // Painel do comprador depois dos contadores: a sessão do SL atende uma chamada por vez
          if (oModule.id === "compras" && oModule.buyer) { p.then(this._loadDash.bind(this)); }
        }
      }.bind(this));
    },

    _loadCounters: function (sModule) {
      var that = this;
      var done = function (oCounts) {
        Object.keys(that._counters).forEach(function (k) {
          if (k.indexOf(sModule + ".") !== 0) { return; }
          var o = that._counters[k];
          var v = oCounts[k.split(".")[1]];
          o.tile.setState("Loaded");
          o.control.setValue(v === undefined ? "–" : String(v));
          if (o.critical && v > 0) { o.control.setValueColor("Critical"); }
        });
      };
      return this.api.get("/api/m/" + sModule + "/counters").then(done).catch(function () { done({}); });
    },

    // ---------- Saudação + painel do comprador ----------
    _renderHeader: function () {
      var oDash = this.byId("dash");
      oDash.destroyItems();
      var oSession = this.getModel("session");
      var h = new Date().getHours();
      var sHello = this.text(h < 12 ? "homeMorning" : h < 18 ? "homeAfternoon" : "homeEvening", [String(oSession.getProperty("/user/userName") || "").split(" ")[0]]);
      var sToday = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
      oDash.addItem(new VBox({ items: [
        new Title({ text: sHello, level: "H1", titleStyle: "H2" }).addStyleClass("pbHello"),
        new Text({ text: oSession.getProperty("/tenant/name") + " · " + sToday })
      ] }).addStyleClass("sapUiSmallMarginBottom"));
      this._dashBox = null;
    },

    _loadDash: function (iYear) {
      var oDash = this.byId("dash");
      var y = iYear || this._dashYear || new Date().getFullYear();
      this._dashYear = y;
      if (!this._dashBox) {
        var cur = new Date().getFullYear();
        var oYears = new SegmentedButton({ width: "14rem", selectedKey: String(y), selectionChange: function (e) { this._loadDash(Number(e.getParameter("item").getKey())); }.bind(this),
          items: [cur - 2, cur - 1, cur].map(function (n) { return new SegmentedButtonItem({ key: String(n), text: String(n) }); }) });
        oDash.addItem(new HBox({ justifyContent: "SpaceBetween", alignItems: "Center", wrap: "Wrap", items: [
          new Title({ text: this.text("dashTitle"), level: "H2", titleStyle: "H4" }).addStyleClass("pbModuleTitle"),
          new HBox({ alignItems: "Center", items: [oYears,
            new Button({ icon: "sap-icon://refresh", tooltip: this.text("refresh"), type: "Transparent", press: function () { this._loadDash(this._dashYear, true); }.bind(this) })] })
        ] }).addStyleClass("sapUiSmallMarginBottom"));
        this._dashBox = new FlexBox({ wrap: "Wrap", alignItems: "Stretch" }).addStyleClass("pbDash sapUiMediumMarginBottom");
        oDash.addItem(this._dashBox);
      }
      var bRefresh = arguments[1] === true;
      this._dashBox.setBusyIndicatorDelay(0).setBusy(true);
      this.api.get("/api/m/compras/dashboard?year=" + y + (bRefresh ? "&refresh=1" : "")).then(this._renderDash.bind(this))
        .catch(function () {}).finally(function () { this._dashBox.setBusy(false); }.bind(this));
    },

    _card: function (sTitle, aItems, sRoute) {
      var oCard = new VBox({ items: [new Label({ text: sTitle }).addStyleClass("pbDashLabel")].concat(aItems) }).addStyleClass("pbDashCard");
      if (sRoute) {
        oCard.addStyleClass("pbDashLink");
        oCard.attachBrowserEvent("click", function () { this.getRouter().navTo(sRoute); }.bind(this));
      }
      return oCard;
    },

    /** Barras mensais em HTML simples (sem biblioteca de gráficos). */
    _bars: function (aValues) {
      var max = Math.max.apply(null, aValues.concat([1]));
      var sMonths = "JFMAMJJASOND";
      var sNow = new Date().getFullYear() === this._dashYear ? new Date().getMonth() : -1;
      var fmt = this.formatter;
      return new HTML({ content: "<div class=\"pbBars\">" + aValues.map(function (v, i) {
        var h = Math.max(Math.round((v / max) * 100), v > 0 ? 4 : 1);
        return "<div class=\"pbBar" + (i === sNow ? " pbBarNow" : "") + "\" title=\"" + fmt.money(v) + "\"><span style=\"height:" + h + "%\"></span><em>" + sMonths[i] + "</em></div>";
      }).join("") + "</div>" });
    },

    _renderDash: function (d) {
      var oBox = this._dashBox;
      var fmt = this.formatter;
      oBox.destroyItems();
      if (d.orders) {
        oBox.addItem(this._card(this.text("dashSpend", [d.year]), [
          new ObjectNumber({ number: fmt.money(d.orders.total) }).addStyleClass("pbDashValue"),
          new Text({ text: this.text("dashOrders", [d.orders.count]) }),
          this._bars(d.orders.monthly)
        ], "compras.orders").addStyleClass("pbDashWide"));
        oBox.addItem(this._card(this.text("dashOpen"), [
          new ObjectNumber({ number: String(d.orders.open.count) }).addStyleClass("pbDashValue"),
          new Text({ text: fmt.money(d.orders.open.total) }),
          new ObjectStatus({ text: this.text("dashLate", [d.orders.late.count, fmt.money(d.orders.late.total)]),
            state: d.orders.late.count ? "Error" : "Success", icon: d.orders.late.count ? "sap-icon://alert" : "sap-icon://accept" }).addStyleClass("sapUiTinyMarginTop")
        ], "compras.orders"));
      }
      oBox.addItem(this._card(this.text("dashSaving"), [
        new ObjectNumber({ number: fmt.money(d.rfq.saving), state: d.rfq.saving > 0 ? "Success" : d.rfq.saving < 0 ? "Warning" : "None" }).addStyleClass("pbDashValue"),
        new Text({ text: d.rfq.savingPct === null ? this.text("dashSavingNone")
          : this.text(d.rfq.savingPct >= 0 ? "dashSavingPct" : "dashSavingAbove", [String(Math.abs(d.rfq.savingPct)).replace(".", ",")]) }),
        new Text({ text: this.text("dashRfq", [d.rfq.count, d.rfq.open, d.rfq.responseRate === null ? "–" : d.rfq.responseRate]) }).addStyleClass("sapUiTinyMarginTop")
      ], "compras.rfqs"));
      if (d.agreements) {
        oBox.addItem(this._card(this.text("dashContracts"), [
          new ObjectNumber({ number: String(d.agreements.active) }).addStyleClass("pbDashValue"),
          new ProgressIndicator({ percentValue: Math.min(d.agreements.consumption || 0, 100), displayValue: this.text("dashConsumed", [fmt.pct(d.agreements.consumption || 0)]),
            state: fmt.consumptionState(d.agreements.consumption), displayOnly: true }),
          new ObjectStatus({ text: this.text("dashExpiring", [d.agreements.expiring]), state: d.agreements.expiring ? "Warning" : "None",
            icon: "sap-icon://appointment-2" })
        ], "compras.contracts"));
      }
      if (d.orders && d.orders.topVendors.length) {
        var max = d.orders.topVendors[0].total || 1;
        oBox.addItem(this._card(this.text("dashTopVendors"), d.orders.topVendors.map(function (v) {
          return new VBox({ items: [
            new HBox({ justifyContent: "SpaceBetween", items: [new Text({ text: v.cardName, wrapping: false }), new Text({ text: fmt.money(v.total) })] }),
            new HTML({ content: "<div class=\"pbHBar\"><span style=\"width:" + Math.max(Math.round((v.total / max) * 100), 2) + "%\"></span></div>" })
          ] }).addStyleClass("sapUiTinyMarginTop");
        })).addStyleClass("pbDashWide"));
      }
    }
  });
});
