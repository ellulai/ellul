"""Minimal Django settings for {{PROJECT_NAME}}."""
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent

SECRET_KEY = "insecure-scaffold-key-replace-before-deploy"
DEBUG = True
ALLOWED_HOSTS = ["*"]

INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
]

MIDDLEWARE: list[str] = []
ROOT_URLCONF = "config.urls"
TEMPLATES: list[dict] = []
WSGI_APPLICATION = "config.wsgi.application"
STATIC_URL = "static/"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
