sap.ui.define([
  "./BaseController",
  "sap/ui/model/json/JSONModel",
  "sap/ui/Device",
  "sap/m/ActionSheet",
  "sap/m/Button",
  "sap/m/ResponsivePopover",
  "sap/m/List",
  "sap/m/StandardListItem"
], function (BaseController, JSONModel, Device, ActionSheet, Button, ResponsivePopover, List, StandardListItem) {
  "use strict";

  /**
   * Menu lateral. Cada entrada aponta para um tile liberado ao usuário (modulo.tile) ou para o
   * primeiro tile de um módulo; entradas sem acesso não aparecem. "Compras" agrupa os tiles de
   * compras que não têm entrada própria (nova solicitação, aprovações, ofertas, contratos).
   */
  var NAV = [
    { key: "home", textKey: "navHome", icon: "sap-icon://home", route: "home" },
    { key: "compras", textKey: "navCompras", icon: "sap-icon://cart", group: "compras", own: ["mine", "rfq", "orders", "receipts"] },
    { key: "solicitacoes", textKey: "navRequests", icon: "sap-icon://my-sales-order", tile: "compras.mine" },
    { key: "cotacoes", textKey: "navRfqs", icon: "sap-icon://compare", tile: "compras.rfq" },
    { key: "pedidos", textKey: "navOrders", icon: "sap-icon://sales-order", tile: "compras.orders" },
    { key: "recebimentos", textKey: "navReceipts", icon: "sap-icon://receipt", tile: "compras.receipts" },
    { key: "fornecedores", textKey: "navPartners", icon: "sap-icon://supplier", module: "parceiros" },
    { key: "relatorios", textKey: "navReports", icon: "sap-icon://business-objects-experience", module: "relatorios" },
    { key: "despesas", textKey: "navExpenses", icon: "sap-icon://travel-expense", module: "despesas" },
    { key: "ia", textKey: "navAi", icon: "sap-icon://ai", module: "ia" },
    { key: "config", textKey: "navSettings", icon: "sap-icon://action-settings", module: "admin" }
  ];

  // Rota -> entrada do menu (telas de detalhe ficam com a entrada da lista de origem)
  var ROUTE_KEY = {
    "home": "home",
    "compras.mine": "solicitacoes",
    "compras.rfqs": "cotacoes", "compras.rfqNew": "cotacoes", "compras.rfq": "cotacoes",
    "compras.orders": "pedidos", "compras.orderNew": "pedidos",
    "compras.receipts": "recebimentos", "compras.receive": "recebimentos",
    "compras.new": "compras.new", "compras.approvals": "compras.approvals", "compras.offers": "compras.offers",
    "compras.contracts": "compras.contracts", "compras.contractNew": "compras.contracts", "compras.contract": "compras.contracts"
  };
  var MODULE_KEY = { parceiros: "fornecedores", relatorios: "relatorios", despesas: "despesas", ia: "ia", admin: "config" };

  return BaseController.extend("portal.b1.controller.App", {
    onInit: function () {
      this.getView().addStyleClass(this.getOwnerComponent().getContentDensityClass());
      var bNarrow = Device.media.getCurrentRange(Device.media.RANGESETS.SAP_STANDARD).name === "Phone";
      this.setModel(new JSONModel({ sideExpanded: !bNarrow, selectedKey: "home", nav: [] }), "shell");
      this._routes = {};
      // setData() da sessão (login/troca de usuário) não dispara propertyChange: escuta pela binding
      this._modulesBinding = this.getModel("session").bindProperty("/modules");
      this._modulesBinding.attachChange(this._buildNav, this);
      this.getRouter().attachRouteMatched(this._onRoute, this);
      Device.media.attachHandler(function (p) { this.getModel("shell").setProperty("/sideExpanded", p.name !== "Phone"); }, this);
      this._buildNav();
    },

    _buildNav: function () {
      var oSession = this.getModel("session");
      var aModules = oSession.getProperty("/modules") || [];
      var tiles = {};
      var that = this;
      aModules.forEach(function (m) { (m.tiles || []).forEach(function (t) { tiles[m.id + "." + t.id] = t; }); });
      this._routes = {};
      var aNav = [];
      NAV.forEach(function (n) {
        var route = n.route;
        var children;
        if (n.tile) { route = tiles[n.tile] && tiles[n.tile].route; }
        if (n.module) {
          var mod = aModules.filter(function (m) { return m.id === n.module; })[0];
          route = mod && mod.tiles && mod.tiles[0] && mod.tiles[0].route;
        }
        if (n.group) {
          var g = aModules.filter(function (m) { return m.id === n.group; })[0];
          children = ((g && g.tiles) || []).filter(function (t) { return n.own.indexOf(t.id) < 0; }).map(function (t) {
            that._routes[t.route] = t.route;
            return { key: t.route, text: t.title };
          });
          if (!children.length) { return; }
        }
        if (!route && !children) { return; }
        if (route) { that._routes[n.key] = route; }
        aNav.push({ key: n.key, text: that.text(n.textKey), icon: n.icon, children: children || [] });
      });
      this.getModel("shell").setProperty("/nav", aNav);
    },

    _onRoute: function (oEvent) {
      var sName = oEvent.getParameter("name");
      var bLogin = sName === "login";
      this.byId("toolPage").toggleStyleClass("pbNoShell", bLogin);
      if (bLogin) { return; }
      var sKey = ROUTE_KEY[sName] || MODULE_KEY[sName.split(".")[0]];
      if (sKey) { this.getModel("shell").setProperty("/selectedKey", sKey); }
    },

    onNavSelect: function (oEvent) {
      var sKey = oEvent.getParameter("item").getKey();
      if (sKey === "__help") {
        window.open(this.getModel("brand").getProperty("/supportUrl"), "_blank", "noopener");
        return;
      }
      var sRoute = this._routes[sKey];
      if (!sRoute) { return; } // grupo "Compras": só expande
      this.getRouter().navTo(sRoute);
      if (Device.media.getCurrentRange(Device.media.RANGESETS.SAP_STANDARD).name === "Phone") { this.getModel("shell").setProperty("/sideExpanded", false); }
    },

    onToggleSide: function () {
      var oShell = this.getModel("shell");
      oShell.setProperty("/sideExpanded", !oShell.getProperty("/sideExpanded"));
    },

    onHome: function () { this.getRouter().navTo("home"); },

    onUserMenu: function (oEvent) {
      var oSrc = oEvent.getSource();
      if (!this._userMenu) {
        this._userMenu = new ActionSheet({ placement: "Bottom", buttons: [
          new Button({ text: this.text("navSettings"), icon: "sap-icon://action-settings",
            visible: { path: "session>/modules", formatter: function (a) { return (a || []).some(function (m) { return m.id === "admin"; }); } },
            press: function () { this.getRouter().navTo("admin.settings"); }.bind(this) }),
          new Button({ text: this.text("logout"), icon: "sap-icon://log", press: this.onLogout.bind(this) })
        ] });
        this.getView().addDependent(this._userMenu);
      }
      this._userMenu.openBy(oSrc);
    },

    /** Sino: mesmos alertas do quadro "Alertas e pendências" da tela inicial (modelo "alerts"). */
    onBell: function (oEvent) {
      if (!this._bell) {
        var oList = new List({ noDataText: this.text("alertsNone"), items: { path: "alerts>/items", template: new StandardListItem({
          title: "{alerts>text}", icon: "{alerts>icon}", highlight: "{alerts>state}", type: "Active", wrapping: true,
          press: function (e) {
            this.getRouter().navTo(e.getSource().getBindingContext("alerts").getProperty("route"));
            this._bell.close();
          }.bind(this)
        }) } });
        this._bell = new ResponsivePopover({ title: this.text("alertsTitle"), placement: "Bottom", contentWidth: "24rem", content: [oList] });
        this.getView().addDependent(this._bell);
      }
      this._bell.openBy(oEvent.getSource());
    }
  });
});
