'use strict';
/** Usuários do modo demonstração (senha 1234). Espelham campos nativos de OUSR. */
module.exports = {
  requisitante: { userCode: 'requisitante', userName: 'Ana Requisitante', internalKey: 10, email: 'ana@demo.com', department: 1, superuser: false },
  aprovador: { userCode: 'aprovador', userName: 'Carlos Diretor', internalKey: 11, email: 'carlos@demo.com', department: 2, superuser: true },
  comprador: { userCode: 'comprador', userName: 'Diego Comprador', internalKey: 13, email: 'diego@demo.com', department: 4, superuser: false },
  comercial: { userCode: 'comercial', userName: 'Bruna Comercial', internalKey: 12, email: 'bruna@demo.com', department: 3, superuser: false }
};
