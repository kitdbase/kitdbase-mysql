import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

const MYSQL_DATABASE = process.env.MYSQL_DATABASE;
const MYSQL_USER = process.env.MYSQL_USER;
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD;
const MYSQL_HOST = process.env.MYSQL_HOST;
const MYSQL_PORT = process.env.MYSQL_PORT;

class MySQL {
    #pool

    constructor() {
        if (!MySQL.instance) {
            try {
                this.#pool = mysql.createPool({
                    host: MYSQL_HOST,
                    user: MYSQL_USER,
                    password: MYSQL_PASSWORD,
                    database: MYSQL_DATABASE,
                    port: MYSQL_PORT,
                });
                MySQL.instance = this;
            } catch (error) {
                console.error('Error al conectar con MySQL:', error);
            }
        }
  
        return MySQL.instance;
    }

    table(tableName) {
        return new TableQuery(tableName,this.#pool);
    }

    async query(databaseName, sqlQuery) {
        if (typeof databaseName !== 'string' || typeof sqlQuery !== 'string') {
            throw new Error('El nombre de la base de datos y la consulta deben ser cadenas de texto.');
        }
    
        //sqlQuery = this.#cleanSqlDump(sqlQuery);
        const sqlCommands = sqlQuery.split(';').filter(cmd => cmd.trim().length > 0);
    
        try {
            // Ejecutar el comando USE una sola vez al principio
            await this.#pool.query(`USE \`${databaseName}\`;`);
            
            // Ejecutar los comandos SQL uno por uno
            for (const command of sqlCommands) {
                const query = `${command};`; // Ya incluye el punto y coma
                await this.#pool.query(query);
            }
    
            return { success: true };
        } catch (error) {
            console.error('Error al ejecutar la consulta.', error);
            return { error: error.sqlMessage};
        }
    }
}

class TableQuery {
    #conection;
    #nextType; // Almacenar el tipo para la próxima condición
    #joins; // Almacenar los JOINs
    #orderBy; // Almacenar los ORDER BY
    #distinct;
    #groupBy; // Almacenar los GROUP BY

    constructor(tableName, conection=null) {
        this.tableName = tableName;
        this.fields = [];
        this.#nextType = 'AND'; 
        this.#joins = []; // Inicializar JOINs
        this.query = `SELECT * FROM \`${tableName}\``; // Consulta básica
        this.conditions = []; // Para almacenar las condiciones WHERE
        this.#distinct = false; // Inicialmente no usar DISTINCT
        this.#orderBy = []; // Inicializar ORDER BY
        this.#groupBy = []; // Inicializar GROUP BY
        this.#conection = conection; // Inicializar GROUP BY
    }

    columns(){
        return new Columns(this.tableName, this.#conection);
    }
    
    async create(fields) {
        try {
            const fieldsDefinition = fields.map(field => {
                const { key, type, defaultValue, length, options, foreing } = field;
    
                if (!key || !type) {
                    throw new Error('Cada campo debe tener un nombre y un tipo.');
                }
    
                let fieldDefinition = (length && type != "text") ? `\`${key}\` ${type}(${length})` : `\`${key}\` ${type}`;

                if(defaultValue){
                    fieldDefinition += (['VARCHAR', 'CHAR', 'TEXT', 'ENUM', 'SET'].includes(type.toUpperCase())) 
                    ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                    : (defaultValue === 'NONE' || defaultValue === null) 
                        ? ''
                        : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
                }
    
                // Si tiene opciones adicionales como primary o unique
                if (options) {
                    if (options.includes('primary')) {
                        fieldDefinition += ' PRIMARY KEY';
                    }
                    if (options.includes('autoincrement')) {
                        fieldDefinition += ' AUTO_INCREMENT';
                    }
                    if (options.includes('unique')) {
                        fieldDefinition += ' UNIQUE';
                    }
                }
    
                // Si es una llave foránea
                if (foreing) {
                    fieldDefinition += `, FOREIGN KEY (\`${key}\`) REFERENCES \`${foreing.table}\`(\`${foreing.column}\`)`;
                }
    
                return fieldDefinition;
            }).join(', ');
    
            let sqlQuery = `CREATE TABLE IF NOT EXISTS \`${this.tableName}\` (${fieldsDefinition}`;
    
            sqlQuery += ')';
            await this.#get_response(sqlQuery);
            return true;
    
        } catch (error) {
            //console.error('Error al crear la tabla.', error);
            throw error;
        }
    }

    async drop() {
        try {
            const sqlQuery = `DROP TABLE IF EXISTS \`${this.tableName}\``;
            await this.#get_response(sqlQuery);
            return true;
        } catch (error) {
            throw new Error('Error al eliminar la tabla: ' + error.message);
        }
    }
    

    select(fields = []) {
        if (fields.length > 0) {
            this.query = `SELECT ${this.#distinct ? 'DISTINCT ' : ''}${fields.join(', ')} FROM \`${this.tableName}\``;
        }
        return this;
    }

    where(column, operator, value) {
        this.conditions.push({ column, operator, value, type: this.#nextType, isGroup: false });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    orWhere(column, operator, value) {
        this.conditions.push({ column, operator, value, type: 'OR', isGroup: false });
        return this;
    }

    whereGroup(callback) {
        const groupQuery = new TableQuery(this.tableName);
        callback(groupQuery);
        const groupConditions = groupQuery.buildConditions(); // Construir solo las condiciones sin SELECT ni WHERE
        this.conditions.push({ query: groupConditions, type: this.#nextType, isGroup: true });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar un grupo
        return this;
    }
    
    or() {
        this.#nextType = 'OR';
        return this;
    }

    and() {
        this.#nextType = 'AND';
        return this;
    }

    whereBetween(column, [value1, value2]) {
        if (Array.isArray([value1, value2]) && value1 !== undefined && value2 !== undefined) {
            this.conditions.push({ column, operator: 'BETWEEN', value: [value1, value2], type: this.#nextType, isGroup: false });
            this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        }
        return this;
    }

    whereIn(column, values) {
        if (Array.isArray(values) && values.length > 0) {
            this.conditions.push({ column, operator: 'IN', value: values, type: this.#nextType, isGroup: false });
            this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        }
        return this;
    }

    whereNull(column) {
        this.conditions.push({ column, operator: 'IS NULL', type: this.#nextType, isGroup: false });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    whereNotNull(column) {
        this.conditions.push({ column, operator: 'IS NOT NULL', type: this.#nextType, isGroup: false });
        this.#nextType = 'AND'; // Reiniciar el tipo después de agregar una condición
        return this;
    }

    buildQuery(includeSelect = true) {
        let query = includeSelect ? this.query : ''; // Si se incluye el SELECT o no

        // Añadir JOINs
        if (this.#joins.length > 0) {
            query += ` ${this.#joins.join(' ')}`;
        }

        const whereClauses = this.buildConditions();

        if (whereClauses.length > 0) {
            query += ` WHERE ${whereClauses}`;
        }

        // Añadir GROUP BY
        if (this.#groupBy.length > 0) {
            query += ` GROUP BY ${this.#groupBy.join(', ')}`;
        }

        if (this.limitValue !== null && this.limitValue !== undefined && !Number.isNaN(this.limitValue)) {
            query += ` LIMIT ${this.limitValue}`;
          }
      
          if (this.pageValue !== null && this.pageValue !== undefined && !Number.isNaN(this.pageValue)) {
            const offset = (this.pageValue - 1) * this.limitValue;
            query += ` OFFSET ${offset}`;
          }

        // Añadir ORDER BY solo si no es una consulta agregada (como COUNT, SUM, etc.)
        if (this.#orderBy.length > 0 && !this.query.startsWith('SELECT COUNT') && !this.query.startsWith('SELECT SUM') && !this.query.startsWith('SELECT AVG') && !this.query.startsWith('SELECT MAX') && !this.query.startsWith('SELECT MIN')) {
            const orderByClauses = this.#orderBy
                .map(order => `${order.column} ${order.direction}`)
                .join(', ');
            query += ` ORDER BY ${orderByClauses}`;
        }

        return query;
    }

    buildConditions() {
      return this.conditions
          .map((cond, index) => {
              const prefix = index === 0 ? '' : ` ${cond.type} `;
              if (cond.isGroup) {
                  return `${prefix}(${cond.query})`;
              }
              let conditionStr = '';
              if (cond.operator === 'BETWEEN') {
                  const [value1, value2] = cond.value;
                  const formattedValue1 = typeof value1 === 'string' ? `'${value1}'` : value1;
                  const formattedValue2 = typeof value2 === 'string' ? `'${value2}'` : value2;
                  conditionStr = `${cond.column} BETWEEN ${formattedValue1} AND ${formattedValue2}`;
              } else if (cond.operator === 'IN') {
                  const values = cond.value.map(val => typeof val === 'string' ? `'${val}'` : val).join(', ');
                  conditionStr = `${cond.column} IN (${values})`;
              } else if (cond.operator === 'IS NULL') {
                  conditionStr = `${cond.column} IS NULL`;
              } else if (cond.operator === 'IS NOT NULL') {
                  conditionStr = `${cond.column} IS NOT NULL`;
              } else {
                  const value = typeof cond.value === 'string' ? `'${cond.value}'` : cond.value;
                  conditionStr = `${cond.column} ${cond.operator} ${value}`;
              }
              return `${prefix}${conditionStr}`;
          })
          .join('');
    }

    join(table, column1, operator, column2) {
        this.#joins.push(`JOIN ${table} ON ${column1} ${operator} ${column2}`);
        return this;
    }

    leftJoin(table, column1, operator, column2) {
        this.#joins.push(`LEFT JOIN ${table} ON ${column1} ${operator} ${column2}`);
        return this;
    }

    rightJoin(table, column1, operator, column2) {
        this.#joins.push(`RIGHT JOIN ${table} ON ${column1} ${operator} ${column2}`);
        return this;
    }

    orderBy(column, direction = 'ASC') {
      const validDirections = ['ASC', 'DESC'];
      if (validDirections.includes(direction.toUpperCase())) {
          this.#orderBy.push({ column, direction: direction.toUpperCase() });
      } else {
          throw new Error(`Invalid direction: ${direction}. Use 'ASC' or 'DESC'.`);
      }
      return this;
    }

    groupBy(column) {
        this.#groupBy.push(column);
        return this;
    }

    distinct() {
      this.#distinct = true;
      this.query = this.query.replace(/^SELECT /, 'SELECT DISTINCT '); // Cambia SELECT a SELECT DISTINCT si ya se ha establecido DISTINCT
      return this;
    }

    count(column = '*') {
        this.query = `SELECT COUNT(${column}) AS count FROM ${this.tableName}`;
        return this;
    }

    sum(column) {
        this.query = `SELECT SUM(${column}) AS sum FROM \`${this.tableName}\``;
        return this;
    }

    avg(column) {
        this.query = `SELECT AVG(${column}) AS avg FROM \`${this.tableName}\``;
        return this;
    }

    max(column) {
        this.query = `SELECT MAX(${column}) AS max FROM \`${this.tableName}\``;
        return this;
    }

    min(column) {
        this.query = `SELECT MIN(${column}) AS min FROM \`${this.tableName}\``;
        return this;
    }

    limit(number) {
        this.limitValue = number;
        return this; 
    }

    page(number) {
        this.pageValue = number;
        return this; 
    }

    async get() {
      const sqlQuery = this.buildQuery();
      try {
          const result = await this.#get_response(sqlQuery);
          return result; // Devuelve todos los resultados
      } catch (error) {
          throw error;
      }
    }

    async first() {
        const sqlQuery = this.buildQuery();
        try {
            const result = await this.#get_response(sqlQuery);
            return result[0] || null; // Devuelve el primer resultado o null si no hay resultados
        } catch (error) {
            //console.error('Error al obtener el primer resultado.', error);
            throw error;
        }
    }

    async find(value, column = 'id') {
        this.where(column, '=', value); // Agregar una condición WHERE
        const sqlQuery = this.buildQuery();
        try {
            const result = await this.#get_response(sqlQuery);
            return result[0] || null; // Devuelve el primer resultado o null si no hay resultados
        } catch (error) {
            //console.error('Error al encontrar el registro.', error);
            throw error;
        }
    }
    
    async insert(data) {
        // Verifica si data NO es un array
        if (!Array.isArray(data)) {
            throw new Error('El método insert requiere un array de objetos con pares clave-valor.');
        }
    
        // Asegúrate de que el array contenga solo objetos
        if (!data.every(item => typeof item === 'object' && item !== null)) {
            throw new Error('El array debe contener solo objetos válidos.');
        }
    
        try {
            const results = [];
    
            for (const row of data) {
                const keys = Object.keys(row).map(key => `\`${key}\``);
                const values = Object.values(row).map(value => {
                    if (value === undefined || value === null) {
                        return 'NULL'; // Maneja valores undefined o null
                    }
                    return typeof value === 'string' ? `'${value}'` : value;
                });
    
                const columns = keys.join(', ');
                const placeholders = values.join(', ');
    
                const sqlQuery = `INSERT INTO \`${this.tableName}\` (${columns}) VALUES (${placeholders})`;
    
                const result = await this.#get_response(sqlQuery);
                const insertedRow = await this.where('id', '=', result.insertId || 0).first();
                results.push(insertedRow);
            }
    
            return results;
        } catch (error) {
            throw new Error('Error al insertar los datos: ' + error.message);
        }
    }

    async update(data) {
      if (typeof data !== 'object' || Array.isArray(data)) {
          throw new Error('El método update requiere un objeto con pares clave-valor.');
      }

      const updates = Object.keys(data).map(key => {
          const value = data[key];
          return `${key} = ${typeof value === 'string' ? `'${value}'` : value}`;
      }).join(', ');

      const whereClauses = this.buildConditions();

      if (whereClauses.length === 0) {
          throw new Error('Debe especificar al menos una condición WHERE para realizar un update.');
      }

      const sqlQuery = `UPDATE \`${this.tableName}\` SET ${updates} WHERE ${whereClauses}`;

      try {
          const result = await this.#get_response(sqlQuery);
          return result;
      } catch (error) {
          //console.error('Error al actualizar los datos.', error);
          throw error;
      }
    }

    async delete() {
        const whereClauses = this.buildConditions();

        if (whereClauses.length === 0) {
            throw new Error('Debe especificar al menos una condición WHERE para realizar un delete.');
        }

        const sqlQuery = `DELETE FROM \`${this.tableName}\` WHERE ${whereClauses}`;

        try {
            const result = await this.#get_response(sqlQuery);
            return result;
        } catch (error) {
            //console.error('Error al eliminar los datos.', error);
            throw error;
        }
    }

    async #get_response(sql) {
        const pool = await this.#conection;
        try {
            const [result] = await pool.query(sql);
            return result;
        } catch (error) {
            if (error.code === 'ER_BAD_DB_ERROR') {
                try {
                    await this.#conection.end();
                    this.#conection = mysql.createPool({
                        host: MYSQL_HOST,
                        user: MYSQL_USER,
                        password: MYSQL_PASSWORD,
                        port: MYSQL_PORT,
                    });
                    const pool_aux = await this.#conection;
                    await pool_aux.query(`CREATE DATABASE \`${MYSQL_DATABASE}\``);
                    await this.#conection.end();
                    this.#conection = mysql.createPool({
                        host: MYSQL_HOST,
                        user: MYSQL_USER,
                        password: MYSQL_PASSWORD,
                        database: MYSQL_DATABASE,
                        port: MYSQL_PORT,
                    });
                    const pool = await this.#conection;
                    const [result] = await pool.query(sql);
                    return result;
                } catch (error) {
                    //console.error('Error al crear la base de datos:', error);
                    throw error;
                }
            }
            //console.error('Error al ejecutar la consulta.', error);
            throw error;
        }
    }
}

class Columns {
    #conection;

    constructor(tableName, conection=null) {
        this.tableName = tableName;
        this.#conection = conection; // Inicializar GROUP BY
    }
    async get() {
        try {
            // Verifica si la tabla ya existe
            const tableExistsQuery = `SHOW TABLES LIKE '${this.tableName}'`;
            const tableExistsResult = await this.#get_response(tableExistsQuery);
    
            if (tableExistsResult.length > 0) {
                // La tabla existe, obtenemos su estructura actual
                const existingFieldsQuery = `SHOW COLUMNS FROM \`${this.tableName}\``;
                const existingFields = await this.#get_response(existingFieldsQuery);
    
                // Mapeamos los campos actuales en un formato más manejable
                return existingFields.reduce((acc, field) => {
                    acc[field.Field] = {
                        type: field.Type,
                        defaultValue: field.Default,
                        key: field.Key,
                        extra: field.Extra
                    };
                    return acc;
                }, {});
            } else {
                return {}; // La tabla no existe
            }
        } catch (error) {
            throw error;
        }
    }
    
    async add(fields) {
        try {
            const currentFields = await this.get();
    
            for (const field of fields) {
                const { key, type, length, defaultValue, options, foreing } = field;
                const fullType = (length && type !== "TEXT") ? `${type}(${length})` : type;
    
                if (!currentFields[key]) {
                    // El campo no existe, agregamos una nueva columna
                    let alterQuery = `ALTER TABLE \`${this.tableName}\` ADD COLUMN \`${key}\` ${fullType}`;
                    
                    if(defaultValue){
                        alterQuery += (['varchar', 'char', 'text', 'enum', 'set'].includes(type)) 
                        ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                        : (defaultValue === 'NONE' || defaultValue === null) 
                            ? ''
                            : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
                    }

                    if (options) {
                        if (options.includes('primary')) {
                            alterQuery += ' PRIMARY KEY';
                        }
                        if (options.includes('autoincrement')) {
                            alterQuery += ' AUTO_INCREMENT';
                        }
                        if (options.includes('unique')) {
                            alterQuery += ' UNIQUE';
                        }
                    }
                    if (foreing) {
                        alterQuery += `, ADD FOREIGN KEY (\`${key}\`) REFERENCES \`${foreing.table}\`(\`${foreing.column}\`)`;
                    }

                    await this.#get_response(alterQuery);
                }
            }
    
            return true;
        } catch (error) {
            console.error('Error al agregar columnas.', error);
            throw error;
        }
    }
    
    async edit(fields) {
        try {
            const currentFields = await this.get();
    
            for (const field of fields) {
                const { key, type, length, defaultValue, options, foreing } = field;
                const fullType = (length && type !== "TEXT") ? `${type}(${length})` : type;
    
                if (currentFields[key]) {
                    // El campo existe, verificamos si tiene diferencias
                    const existingField = currentFields[key];

                    if (existingField.type !== fullType || existingField.defaultValue !== defaultValue ||
                        (options && options.includes('autoincrement') && existingField.extra !== 'auto_increment') ||
                        (options && options.includes('unique') && existingField.key !== 'UNI') ||
                        (options && options.includes('primary') && existingField.key !== 'PRI')) { 

                        // Modificamos la columna existente
                        let modifyQuery = `ALTER TABLE \`${this.tableName}\` MODIFY COLUMN \`${key}\` ${fullType}`;

                        if(existingField.defaultValue !== defaultValue){
                            modifyQuery += (['varchar', 'char', 'text', 'enum', 'set'].includes(type)) 
                            ? (defaultValue ? ` DEFAULT '${defaultValue}'` : ` DEFAULT NULL`)
                            : (defaultValue === 'NONE' || defaultValue === null) 
                                ? ''
                                : (defaultValue ? ` DEFAULT ${defaultValue}` : ` DEFAULT NULL`);
                        }

                        if (options) {
                            if (options.includes('primary')) {
                                modifyQuery += ' PRIMARY KEY';
                            }
                            if (options.includes('autoincrement')) {
                                modifyQuery += ' AUTO_INCREMENT';
                            }
                            if (options.includes('unique')) {
                                modifyQuery += ' UNIQUE';
                            }
                        }
                        
                        if (foreing) {
                            modifyQuery += `, ADD FOREIGN KEY (\`${key}\`) REFERENCES \`${foreing.table}\`(\`${foreing.column}\`)`;
                        }

                        await this.#get_response(modifyQuery);
                    }
                }
            }
    
            return true;
        } catch (error) {
            console.error('Error al editar columnas.', error);
            throw error;
        }
    }

    async delete(fields) {
        try {
            const currentFields = await this.get();
    
            for (const key of fields) {
                if (currentFields[key]) {
                    // Eliminar columna existente
                    let dropQuery = `ALTER TABLE ${this.tableName} DROP COLUMN \`${key}\`;`;
                    await this.#get_response(dropQuery);
                }
            }
    
            return true;
        } catch (error) {
            //console.error('Error al eliminar columnas.', error);
            throw error;
        }
    }

    async #get_response(sql) {
        const pool = await this.#conection;
        try {
            const [result] = await pool.query(sql);
            return result;
        } catch (error) {
            if (error.code === 'ER_BAD_DB_ERROR') {
                try {
                    await this.#conection.end();
                    this.#conection = mysql.createPool({
                        host: MYSQL_HOST,
                        user: MYSQL_USER,
                        password: MYSQL_PASSWORD,
                        port: MYSQL_PORT,
                    });
                    const pool_aux = await this.#conection;
                    await pool_aux.query(`CREATE DATABASE \`${MYSQL_DATABASE}\``);
                    await this.#conection.end();
                    this.#conection = mysql.createPool({
                        host: MYSQL_HOST,
                        user: MYSQL_USER,
                        password: MYSQL_PASSWORD,
                        database: MYSQL_DATABASE,
                        port: MYSQL_PORT,
                    });
                    const pool = await this.#conection;
                    const [result] = await pool.query(sql);
                    return result;
                } catch (error) {
                    //console.error('Error al crear la base de datos:', error);
                    throw error;
                }
            }
            //console.error('Error al ejecutar la consulta.', error);
            throw error;
        }
    }
}

const db = new MySQL();
export default db;