from pathlib import Path
from setuptools import find_packages, setup

ROOT_DIR = Path(__file__).resolve().parent
README_PATH = ROOT_DIR / "README.md"
long_description = (
    README_PATH.read_text(encoding="utf-8")
    if README_PATH.exists()
    else "Official Python client SDK for DataStack — Self-Hosted Real-Time Telemetry & Event Logging Platform"
)

setup(
    name="datastack-sdk",
    version="2.2.0",
    description="Official Python client SDK for DataStack — Self-Hosted Real-Time Telemetry & Event Logging Platform",
    long_description=long_description,
    long_description_content_type="text/markdown",
    author="Vib Tools",
    author_email="hello@vibtools.io",
    url="https://github.com/vibtoolshq",
    project_urls={
        "Homepage": "https://vib.tools/",
        "Source": "https://github.com/vibtoolshq",
        "Support": "mailto:support@vibtools.io",
    },
    license="MIT",
    packages=find_packages(),
    install_requires=[
        "python-socketio[client]>=5.11.0",
        "requests>=2.31.0",
        "websocket-client>=1.7.0",
    ],
    classifiers=[
        "Development Status :: 5 - Production/Stable",
        "Intended Audience :: Developers",
        "Intended Audience :: System Administrators",
        "Intended Audience :: Science/Research",
        "Topic :: System :: Logging",
        "Topic :: System :: Monitoring",
        "Topic :: Software Development :: Libraries :: Python Modules",
        "Programming Language :: Python :: 3",
        "Programming Language :: Python :: 3.8",
        "Programming Language :: Python :: 3.9",
        "Programming Language :: Python :: 3.10",
        "Programming Language :: Python :: 3.11",
        "Programming Language :: Python :: 3.12",
        "License :: OSI Approved :: MIT License",
        "Operating System :: OS Independent",
    ],
    python_requires=">=3.8",
)
