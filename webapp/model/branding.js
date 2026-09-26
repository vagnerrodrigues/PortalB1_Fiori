sap.ui.define([], function () {
  "use strict";
  // Aplica a identidade visual sobrescrevendo parâmetros do tema SAP Horizon (CSS custom properties).
  // ":root:root" garante precedência sobre o CSS do tema, carregado dinamicamente depois.
  function css(c) {
    return [
      ":root:root{",
      "--sapBrandColor:" + c.primary + ";",
      "--sapHighlightColor:" + c.primary + ";",
      "--sapSelectedColor:" + c.primary + ";",
      "--sapActiveColor:" + c.primary + ";",
      "--sapLinkColor:" + c.primary + ";",
      "--sapLink_Hover_Color:" + c.primaryHover + ";",
      "--sapLink_Active_Color:" + c.primaryHover + ";",
      "--sapButton_Emphasized_Background:" + c.primary + ";",
      "--sapButton_Emphasized_BorderColor:" + c.primary + ";",
      "--sapButton_Emphasized_Hover_Background:" + c.primaryHover + ";",
      "--sapButton_Emphasized_Hover_BorderColor:" + c.primaryHover + ";",
      "--sapButton_Emphasized_Active_Background:" + c.primaryHover + ";",
      "--sapButton_Emphasized_Active_BorderColor:" + c.primaryHover + ";",
      "--sapButton_TextColor:" + c.primary + ";",
      "--sapButton_Lite_TextColor:" + c.primary + ";",
      "--sapButton_Selected_TextColor:" + c.primary + ";",
      "--sapButton_Selected_BorderColor:" + c.primary + ";",
      "--sapTile_IconColor:" + c.primary + ";",
      "--sapButton_Hover_TextColor:" + c.primaryHover + ";",
      "--sapContent_FocusColor:" + c.primary + ";",
      "--sapField_Focus_BorderColor:" + c.primary + ";",
      "--sapContent_IconColor:" + c.primary + ";",
      "--sapShellColor:" + c.header + ";",
      "--pbHeader:" + c.header + ";",
      "--pbHeaderText:" + c.headerText + ";",
      "--pbAccent:" + c.accent + ";",
      "--pbLoginFrom:" + c.loginFrom + ";",
      "--pbLoginTo:" + c.loginTo + ";",
      "}"
    ].join("");
  }

  return {
    apply: function (oBrand) {
      if (!oBrand || !oBrand.colors) { return; }
      var oStyle = document.getElementById("pb-brand");
      if (!oStyle) {
        oStyle = document.createElement("style");
        oStyle.id = "pb-brand";
        document.head.appendChild(oStyle);
      }
      oStyle.textContent = css(oBrand.colors);
      document.title = oBrand.productName || document.title;
    }
  };
});
