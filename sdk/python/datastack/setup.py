from pathlib import Path
from setuptools import find_packages, setup

ROOT_DIR = Path(__file__).resolve().parent
README_PATH = ROOT_DIR / "README.md"
long_description = (
    README_PATH.read_text(encoding="utf-8")
    if README_PATH.exists()
    else "Official Python SDK for DataStack Real-Time Event Ingestion Platform."
)

setup(
    name="datastack",
    version="2.2.0",
    description=(
        "Official Python SDK for DataStack — Real-Time WebSocket & HTTP Fallback "
        "Telemetry Ingestion Engine with Auto Heartbeat Recovery, Offline Spooling, "
        "and Direct CSV/JSON File Streaming"
    ),
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="Md Anik (Vib Tools)",
    author_email="info@vibtools.top",
    url="https://vibtools.top/",
    license="MIT",
    packages=find_packages(include=["datastack", "datastack.*"]),
    install_requires=[
        "python-socketio[client]>=5.8.0",
        "requests>=2.28.0",
        "websocket-client>=1.5.0",
    ],
    python_requires=">=3.8",
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Intended Audience :: Developers",
        "License :: OSI Approved :: MIT License",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
    ],
)
