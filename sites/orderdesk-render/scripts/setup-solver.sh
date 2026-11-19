#!/bin/sh
set -eu
python3 -m venv --system-site-packages .solver
.solver/bin/python -m pip install --disable-pip-version-check --only-binary=:all: numpy==2.3.5 scipy==1.17.0
