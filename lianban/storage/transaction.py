"""An application use case owns one transaction; nested operations join it."""
from contextlib import contextmanager
@contextmanager
def transaction(conn):
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.rollback()
        raise
    else:
        conn.commit()
