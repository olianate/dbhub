import type { DatabaseType } from '../types/datasource';
import PostgresLogo from '../assets/logos/postgres.svg';
import MySQLLogo from '../assets/logos/mysql.svg';
import MariaDBLogo from '../assets/logos/mariadb.svg';
import SQLServerLogo from '../assets/logos/sqlserver.svg';
import SQLiteLogo from '../assets/logos/sqlite.svg';
import DM8Logo from '../assets/logos/dm8.svg';

export const DB_LOGOS: Record<DatabaseType, string> = {
  postgres: PostgresLogo,
  mysql: MySQLLogo,
  mariadb: MariaDBLogo,
  sqlserver: SQLServerLogo,
  sqlite: SQLiteLogo,
  dm8: DM8Logo,
};
