sap.ui.define([
  "./BaseController",
  "sap/m/Title",
  "sap/m/FlexBox",
  "sap/m/GenericTile",
  "sap/m/TileContent",
  "sap/m/NumericContent",
  "sap/m/ImageContent"
], function (BaseController, Title, FlexBox, GenericTile, TileContent, NumericContent, ImageContent) {
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

        if (oModule.tiles.some(function (t) { return t.counter; })) { this._loadCounters(oModule.id); }
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
      this.api.get("/api/m/" + sModule + "/counters").then(done).catch(function () { done({}); });
    }
  });
});
