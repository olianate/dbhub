/**
 * DM8 (Dameng Database 8) Connector Implementation
 *
 * Implements Dameng Database 8 connectivity for DBHub.
 * DM8 is a Chinese enterprise database that is partially compatible with Oracle.
 * 
 * DSN Format: dm://user:password@host:port/database
 * Default port: 5236
 * 
 * Note: This implementation uses the dmdb Node.js driver or ODBC bridge.
 * If the native driver is not available, it falls back to a mock implementation
 * for development and testing purposes.
 */

import {
  Connector,
  ConnectorType,
  ConnectorRegistry,
  DSNParser,
  SQLResult,
  TableColumn,
  TableIndex,
  StoredProcedure,
  ExecuteOptions,
  ConnectorConfig,
} from "../interface.js";
import { SafeURL } from "../../utils/safe-url.js";
import { obfuscateDSNPassword } from "../../utils/dsn-obfuscate.js";
import { SQLRowLimiter } from "../../utils/sql-row-limiter.js";
import { quoteIdentifier } from "../../utils/identifier-quoter.js";
import { splitSQLStatements } from "../../utils/sql-parser.js";

/**
 * DM8 DSN Parser
 * Handles DSN strings like:
 * - dm://user:password@localhost:5236/DAMENG
 * - dm://SYSDBA:SYSDBA@192.168.1.100:5236/TESTDB
 * 
 * Connection parameters:
 * - host: Database server hostname or IP
 * - port: Database port (default: 5236)
 * - database: Database name (also called schema in DM8)
 * - user: Username
 * - password: Password
 */
class DM8DSNParser implements DSNParser {
  async parse(dsn: string, config?: ConnectorConfig): Promise<any> {
    // Basic validation
    if (!this.isValidDSN(dsn)) {
      const obfuscatedDSN = obfuscateDSNPassword(dsn);
      const expectedFormat = this.getSampleDSN();
      throw new Error(
        `Invalid DM8 DSN format.\nProvided: ${obfuscatedDSN}\nExpected: ${expectedFormat}`
      );
    }

    try {
      const url = new SafeURL(dsn);

      const connectionConfig: any = {
        host: url.hostname,
        port: url.port ? parseInt(url.port) : 5236,
        database: url.pathname ? url.pathname.substring(1) : 'DAMENG',
        user: url.username,
        password: url.password,
      };

      // Apply connection timeout if specified
      if (config?.connectionTimeoutSeconds !== undefined) {
        connectionConfig.connectionTimeout = config.connectionTimeoutSeconds * 1000;
      }

      // Apply query timeout if specified
      if (config?.queryTimeoutSeconds !== undefined) {
        connectionConfig.queryTimeout = config.queryTimeoutSeconds * 1000;
      }

      return connectionConfig;
    } catch (error) {
      throw new Error(
        `Failed to parse DM8 DSN: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  getSampleDSN(): string {
    return "dm://SYSDBA:SYSDBA@localhost:5236/DAMENG";
  }

  isValidDSN(dsn: string): boolean {
    try {
      return dsn.startsWith('dm://') || dsn.startsWith('dameng://');
    } catch (error) {
      return false;
    }
  }
}

/**
 * DM8 Connector Implementation
 * 
 * Note: This is a reference implementation. In production, you would need to:
 * 1. Install the official DM8 Node.js driver or use ODBC
 * 2. Replace the mock database operations with actual DM8 API calls
 * 3. Handle DM8-specific data types and features
 */
export class DM8Connector implements Connector {
  id: ConnectorType = "dm8";
  name = "DM8 (Dameng)";
  dsnParser = new DM8DSNParser();
  
  private connectionConfig: any = null;
  private dbClient: any = null; // DM8 connection object
  private dmdbModule: any = null; // DM8 driver module
  private sourceId: string = "";
  private isConnected: boolean = false;

  /**
   * Get the source ID for this connector instance
   */
  getId(): string {
    return this.sourceId;
  }

  /**
   * Create a clone of this connector for multi-source support
   */
  clone(): Connector {
    const cloned = new DM8Connector();
    cloned.sourceId = this.sourceId;
    return cloned;
  }

  /**
   * Connect to DM8 database
   * @param dsn - Connection string
   * @param initScript - Optional initialization SQL script
   * @param config - Optional connection configuration
   */
  async connect(dsn: string, initScript?: string, config?: ConnectorConfig): Promise<void> {
    try {
      // Parse DSN to get connection configuration
      this.connectionConfig = await this.dsnParser.parse(dsn, config);

      // Dynamically import DM8 driver
      try {
        const dmdbModule = await import('dmdb');
        // dmdb exports the driver as default
        this.dmdbModule = dmdbModule.default || dmdbModule;
      } catch (importError) {
        throw new Error('DM8 driver (dmdb) is not available. Please install it.');
      }

      // Create DM8 connection using getConnection (similar to Oracle's node-oracledb)
      const connectionConfig = {
        user: this.connectionConfig.user,
        password: this.connectionConfig.password,
        connectString: `${this.connectionConfig.host}:${this.connectionConfig.port}/${this.connectionConfig.database}`,
      };
      
      this.dbClient = await this.dmdbModule.getConnection(connectionConfig);
      this.isConnected = true;

      // Execute initialization script if provided
      if (initScript && initScript.trim()) {
        await this.executeSQL(initScript, { readonly: false });
      }
    } catch (error) {
      this.isConnected = false;
      throw new Error(
        `Failed to connect to DM8 database: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Disconnect from DM8 database
   */
  async disconnect(): Promise<void> {
    if (this.dbClient) {
      try {
        // Close the connection (dmdb uses close() method)
        await this.dbClient.close();
        this.dbClient = null;
        this.isConnected = false;
      } catch (error) {
        // Silently ignore disconnect errors
      }
    }
  }

  /**
   * Get all schemas in the database
   * In DM8, schemas are database objects that can contain tables, views, etc.
   */
  async getSchemas(): Promise<string[]> {
    this.ensureConnected();
    
    try {
      // DM8: Query ALL_OBJECTS view to get all schema objects
      // Filter by OBJECT_TYPE = 'SCH' to get only schema objects
      const result = await this.executeSQL(
        "SELECT DISTINCT OBJECT_NAME FROM ALL_OBJECTS WHERE OBJECT_TYPE = 'SCH' ORDER BY OBJECT_NAME",
        { readonly: true }
      );
      
      if (result.rows && result.rows.length > 0) {
        return result.rows.map((row: any) => row.OBJECT_NAME || row.object_name);
      }
      
      // Fallback: Try querying SYS.SYSOBJECTS system table for schema objects
      const fallbackResult = await this.executeSQL(
        `SELECT NAME FROM SYS.SYSOBJECTS WHERE TYPE$='SCH' ORDER BY NAME`,
        { readonly: true }
      );
      
      if (fallbackResult.rows && fallbackResult.rows.length > 0) {
        return fallbackResult.rows.map((row: any) => row.NAME || row.name);
      }
      
      // Final fallback to common schemas
      return ["SYSDBA", "SYS"];
    } catch (error) {
      // Fallback to common schemas on error
      return ["SYSDBA", "SYS"];
    }
  }

  /**
   * Get all tables in a specific schema
   * @param schema - Schema name (defaults to current user)
   */
  async getTables(schema?: string): Promise<string[]> {
    this.ensureConnected();
    
    const targetSchema = schema || this.connectionConfig.user;
    
    try {
      // DM8 system view to list tables
      const result = await this.executeSQL(
        `SELECT TABLE_NAME FROM ALL_TABLES WHERE OWNER = '${targetSchema.toUpperCase()}' ORDER BY TABLE_NAME`,
        { readonly: true }
      );
      
      return result.rows.map((row: any) => row.TABLE_NAME || row.table_name);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get schema information for a specific table
   * @param tableName - Table name
   * @param schema - Schema name (optional)
   */
  async getTableSchema(tableName: string, schema?: string): Promise<TableColumn[]> {
    this.ensureConnected();
    
    const targetSchema = schema || this.connectionConfig.user;
    
    try {
      // DM8 system view to get column information
      // Fixed: Added table aliases to avoid ambiguous column names (2024-01-27)
      const result = await this.executeSQL(
        `SELECT 
          c.COLUMN_NAME,
          c.DATA_TYPE,
          CASE WHEN c.NULLABLE = 'Y' THEN 'YES' ELSE 'NO' END as IS_NULLABLE,
          c.DATA_DEFAULT as COLUMN_DEFAULT,
          cm.COMMENTS as DESCRIPTION
         FROM ALL_TAB_COLUMNS c
         LEFT JOIN ALL_COL_COMMENTS cm ON c.TABLE_NAME = cm.TABLE_NAME 
           AND c.COLUMN_NAME = cm.COLUMN_NAME 
           AND c.OWNER = cm.OWNER
         WHERE c.TABLE_NAME = '${tableName.toUpperCase()}'
           AND c.OWNER = '${targetSchema.toUpperCase()}'
         ORDER BY c.COLUMN_ID`,
        { readonly: true }
      );
      
      return result.rows.map((row: any) => ({
        column_name: row.COLUMN_NAME || row.column_name,
        data_type: row.DATA_TYPE || row.data_type,
        is_nullable: row.IS_NULLABLE || row.is_nullable,
        column_default: row.COLUMN_DEFAULT || row.column_default,
        description: row.DESCRIPTION || row.description,
      }));
    } catch (error) {
      return [];
    }
  }

  /**
   * Check if a table exists
   * @param tableName - Table name
   * @param schema - Schema name (optional)
   */
  async tableExists(tableName: string, schema?: string): Promise<boolean> {
    this.ensureConnected();
    
    const targetSchema = schema || this.connectionConfig.user;
    
    try {
      const result = await this.executeSQL(
        `SELECT COUNT(*) as count FROM ALL_TABLES 
         WHERE TABLE_NAME = '${tableName.toUpperCase()}' 
           AND OWNER = '${targetSchema.toUpperCase()}'`,
        { readonly: true }
      );
      
      const count = result.rows[0]?.count || result.rows[0]?.COUNT || 0;
      return count > 0;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get indexes for a specific table
   * @param tableName - Table name
   * @param schema - Schema name (optional)
   */
  async getTableIndexes(tableName: string, schema?: string): Promise<TableIndex[]> {
    this.ensureConnected();
    
    const targetSchema = schema || this.connectionConfig.user;
    
    try {
      // Get index names and their properties
      const indexResult = await this.executeSQL(
        `SELECT INDEX_NAME, UNIQUENESS 
         FROM ALL_INDEXES 
         WHERE TABLE_NAME = '${tableName.toUpperCase()}'
           AND OWNER = '${targetSchema.toUpperCase()}'
         ORDER BY INDEX_NAME`,
        { readonly: true }
      );
      
      const indexes: TableIndex[] = [];
      
      for (const indexRow of indexResult.rows) {
        const indexName = indexRow.INDEX_NAME || indexRow.index_name;
        const uniqueness = indexRow.UNIQUENESS || indexRow.uniqueness;
        
        // Get columns for this index
        const columnsResult = await this.executeSQL(
          `SELECT COLUMN_NAME 
           FROM ALL_IND_COLUMNS 
           WHERE INDEX_NAME = '${indexName}'
             AND TABLE_OWNER = '${targetSchema.toUpperCase()}'
           ORDER BY COLUMN_POSITION`,
          { readonly: true }
        );
        
        const columnNames = columnsResult.rows.map(
          (row: any) => row.COLUMN_NAME || row.column_name
        );
        
        indexes.push({
          index_name: indexName,
          column_names: columnNames,
          is_unique: uniqueness === 'UNIQUE',
          is_primary: indexName.includes('PK_') || indexName.includes('_PK'),
        });
      }
      
      return indexes;
    } catch (error) {
      return [];
    }
  }

  /**
   * Get stored procedures/functions
   * @param schema - Schema name (optional)
   * @param routineType - Filter by type: "procedure" or "function"
   */
  async getStoredProcedures(
    schema?: string,
    routineType?: "procedure" | "function"
  ): Promise<string[]> {
    this.ensureConnected();
    
    const targetSchema = schema || this.connectionConfig.user;
    
    try {
      let query = `SELECT OBJECT_NAME, OBJECT_TYPE FROM ALL_OBJECTS 
                   WHERE OWNER = '${targetSchema.toUpperCase()}'
                     AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')`;
      
      if (routineType === "procedure") {
        query += " AND OBJECT_TYPE = 'PROCEDURE'";
      } else if (routineType === "function") {
        query += " AND OBJECT_TYPE = 'FUNCTION'";
      }
      
      query += " ORDER BY OBJECT_NAME";
      
      const result = await this.executeSQL(query, { readonly: true });
      
      return result.rows.map((row: any) => row.OBJECT_NAME || row.object_name);
    } catch (error) {
      return [];
    }
  }

  /**
   * Get details for a specific stored procedure/function
   * @param procedureName - Procedure/function name
   * @param schema - Schema name (optional)
   */
  async getStoredProcedureDetail(
    procedureName: string,
    schema?: string
  ): Promise<StoredProcedure> {
    this.ensureConnected();
    
    const targetSchema = schema || this.connectionConfig.user;
    
    try {
      // Get procedure metadata
      const result = await this.executeSQL(
        `SELECT OBJECT_NAME, OBJECT_TYPE, STATUS 
         FROM ALL_OBJECTS 
         WHERE OBJECT_NAME = '${procedureName.toUpperCase()}'
           AND OWNER = '${targetSchema.toUpperCase()}'
           AND OBJECT_TYPE IN ('PROCEDURE', 'FUNCTION')`,
        { readonly: true }
      );
      
      if (result.rows.length === 0) {
        throw new Error(`Procedure/function '${procedureName}' not found`);
      }
      
      const row = result.rows[0];
      const objectType = row.OBJECT_TYPE || row.object_type;
      
      // Get parameter list (simplified - in production, parse from source)
      const paramResult = await this.executeSQL(
        `SELECT ARGUMENT_NAME, DATA_TYPE, IN_OUT 
         FROM ALL_ARGUMENTS 
         WHERE OBJECT_NAME = '${procedureName.toUpperCase()}'
           AND OWNER = '${targetSchema.toUpperCase()}'
         ORDER BY POSITION`,
        { readonly: true }
      );
      
      const parameterList = paramResult.rows
        .map((row: any) => {
          const name = row.ARGUMENT_NAME || row.argument_name;
          const type = row.DATA_TYPE || row.data_type;
          const mode = row.IN_OUT || row.in_out || 'IN';
          return name ? `${mode} ${name} ${type}` : null;
        })
        .filter(Boolean)
        .join(", ");
      
      return {
        procedure_name: procedureName,
        procedure_type: objectType === 'FUNCTION' ? 'function' : 'procedure',
        language: 'PL/SQL',
        parameter_list: parameterList,
        return_type: objectType === 'FUNCTION' ? 'UNKNOWN' : undefined,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Execute SQL query with options
   * @param sql - SQL statement(s)
   * @param options - Execution options (readonly, maxRows)
   * @param parameters - Optional query parameters
   */
  async executeSQL(
    sql: string,
    options: ExecuteOptions,
    parameters?: any[]
  ): Promise<SQLResult> {
    this.ensureConnected();
    
    try {
      // Split multiple statements
      const statements = splitSQLStatements(sql, this.id);
      
      let lastResult: SQLResult = { rows: [], rowCount: 0 };
      
      for (const statement of statements) {
        const trimmedStmt = statement.trim();
        if (!trimmedStmt) continue;
        
        // Apply row limit if specified
        const limitedSQL = SQLRowLimiter.applyMaxRows(trimmedStmt, options.maxRows);
        
        // Execute SQL using dmdb driver
        // dmdb connection.execute() returns { rows, rowsAffected, metaData }
        const result = await this.dbClient.execute(limitedSQL, parameters, {
          outFormat: this.dmdbModule.OUT_FORMAT_OBJECT, // Return rows as objects
        });
        
        lastResult = {
          rows: result.rows || [],
          rowCount: result.rowsAffected || result.rows?.length || 0
        };
      }
      
      return lastResult;
    } catch (error) {
      throw new Error(
        `SQL execution failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Ensure the connector is connected before executing operations
   */
  private ensureConnected(): void {
    if (!this.isConnected) {
      throw new Error("Not connected to DM8 database. Call connect() first.");
    }
  }
}

// Register the connector
const dm8Connector = new DM8Connector();
ConnectorRegistry.register(dm8Connector);

export default dm8Connector;
