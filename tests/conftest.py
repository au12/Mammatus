import os
import sys
import tempfile
from pathlib import Path

_tmp = tempfile.mkdtemp(prefix="mammatus-test-")
os.environ.setdefault("MAMMATUS_DATA_DIR", _tmp)
os.environ.setdefault("MAMMATUS_BACKGROUND", "0")
os.environ.setdefault("MAMMATUS_LOG_LEVEL", "WARNING")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
