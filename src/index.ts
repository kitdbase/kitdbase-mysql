import db from './lib/mysql.js';

export default db;

export const cjsExport = (): any => db;

// Permite exportar CommonJS dinámicamente
if (typeof module !== 'undefined' && typeof require !== 'undefined') {
  module.exports = db;
}
