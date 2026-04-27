/**
 * DM8 Connector Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { DM8Connector } from '../index.js';
import { ConnectorRegistry } from '../../interface.js';

describe('DM8Connector', () => {
  describe('DSN Parser', () => {
    it('should parse valid DM8 DSN', async () => {
      const connector = new DM8Connector();
      const dsn = 'dm://SYSDBA:SYSDBA@localhost:5236/DAMENG';
      
      const config = await connector.dsnParser.parse(dsn);
      
      expect(config).toEqual({
        host: 'localhost',
        port: 5236,
        database: 'DAMENG',
        user: 'SYSDBA',
        password: 'SYSDBA',
      });
    });

    it('should use default port when not specified', async () => {
      const connector = new DM8Connector();
      const dsn = 'dm://user:pass@host/database';
      
      const config = await connector.dsnParser.parse(dsn);
      
      expect(config.port).toBe(5236);
    });

    it('should validate DM8 DSN format', () => {
      const connector = new DM8Connector();
      
      expect(connector.dsnParser.isValidDSN('dm://user:pass@host:5236/db')).toBe(true);
      expect(connector.dsnParser.isValidDSN('dameng://user:pass@host:5236/db')).toBe(true);
      expect(connector.dsnParser.isValidDSN('postgres://user:pass@host:5432/db')).toBe(false);
    });

    it('should throw error for invalid DSN', async () => {
      const connector = new DM8Connector();
      const invalidDSN = 'invalid-dsn';
      
      await expect(connector.dsnParser.parse(invalidDSN)).rejects.toThrow('Invalid DM8 DSN format');
    });
  });

  describe('Connector Registry', () => {
    it('should be registered in ConnectorRegistry', () => {
      const connector = ConnectorRegistry.getConnector('dm8');
      expect(connector).not.toBeNull();
      expect(connector?.id).toBe('dm8');
      expect(connector?.name).toBe('DM8 (Dameng)');
    });

    it('should recognize DM8 DSN', () => {
      const connector = ConnectorRegistry.getConnectorForDSN('dm://user:pass@localhost:5236/db');
      expect(connector).not.toBeNull();
      expect(connector?.id).toBe('dm8');
    });
  });

  describe('Clone', () => {
    it('should create a clone of the connector', () => {
      const connector = new DM8Connector();
      (connector as any).sourceId = 'test-source';
      
      const cloned = connector.clone();
      
      expect(cloned).not.toBe(connector);
      expect((cloned as any).sourceId).toBe('test-source');
      expect(cloned.id).toBe('dm8');
    });
  });

  describe('Schema Query', () => {
    it('should use ALL_OBJECTS view for schema queries', async () => {
      const connector = new DM8Connector();
      
      // Mock the executeSQL method to test the query
      const mockExecuteSQL = vi.fn().mockResolvedValue({
        rows: [
          { OBJECT_NAME: 'SYSDBA' },
          { OBJECT_NAME: 'SYS' },
          { OBJECT_NAME: 'TEST_SCHEMA' },
          { OBJECT_NAME: 'USER_SCHEMA' }
        ]
      });
      
      (connector as any).executeSQL = mockExecuteSQL;
      (connector as any).isConnected = true;
      
      const schemas = await connector.getSchemas();
      
      // Verify the correct query was used
      expect(mockExecuteSQL).toHaveBeenCalledWith(
        "SELECT DISTINCT OBJECT_NAME FROM ALL_OBJECTS WHERE OBJECT_TYPE = 'SCH' ORDER BY OBJECT_NAME",
        { readonly: true }
      );
      
      // Verify all schemas are returned
      expect(schemas).toHaveLength(4);
      expect(schemas).toContain('SYSDBA');
      expect(schemas).toContain('SYS');
      expect(schemas).toContain('TEST_SCHEMA');
      expect(schemas).toContain('USER_SCHEMA');
    });

    it('should fallback to SYSOBJECTS when ALL_OBJECTS returns empty', async () => {
      const connector = new DM8Connector();
      
      let callCount = 0;
      const mockExecuteSQL = vi.fn().mockImplementation((sql: string) => {
        callCount++;
        if (callCount === 1) {
          // First call to ALL_OBJECTS returns empty
          return Promise.resolve({ rows: [] });
        } else {
          // Second call to SYSOBJECTS returns schemas
          return Promise.resolve({
            rows: [
              { NAME: 'SYSDBA' },
              { NAME: 'SYS' },
              { NAME: 'FALLBACK_SCHEMA' }
            ]
          });
        }
      });
      
      (connector as any).executeSQL = mockExecuteSQL;
      (connector as any).isConnected = true;
      
      const schemas = await connector.getSchemas();
      
      // Verify both queries were attempted
      expect(mockExecuteSQL).toHaveBeenCalledTimes(2);
      expect(mockExecuteSQL).toHaveBeenNthCalledWith(
        1,
        "SELECT DISTINCT OBJECT_NAME FROM ALL_OBJECTS WHERE OBJECT_TYPE = 'SCH' ORDER BY OBJECT_NAME",
        { readonly: true }
      );
      expect(mockExecuteSQL).toHaveBeenNthCalledWith(
        2,
        `SELECT NAME FROM SYS.SYSOBJECTS WHERE TYPE$='SCH' ORDER BY NAME`,
        { readonly: true }
      );
      
      // Verify schemas from fallback are returned
      expect(schemas).toHaveLength(3);
      expect(schemas).toContain('SYSDBA');
      expect(schemas).toContain('SYS');
      expect(schemas).toContain('FALLBACK_SCHEMA');
    });
  });
});
