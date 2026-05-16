use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppMode {
    Unset,
    Local,
    Cloud,
}

impl Default for AppMode {
    fn default() -> Self {
        Self::Unset
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub mode: AppMode,
    pub cloud_domain: Option<String>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            mode: AppMode::Unset,
            cloud_domain: None,
        }
    }
}

pub struct ConfigState {
    config: RwLock<AppConfig>,
    path: PathBuf,
}

impl ConfigState {
    pub fn load(data_dir: PathBuf) -> Self {
        let path = data_dir.join("app-config.json");
        let config = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            config: RwLock::new(config),
            path,
        }
    }

    pub fn get(&self) -> AppConfig {
        self.config.read().unwrap().clone()
    }

    pub fn set_mode(&self, mode: AppMode, cloud_domain: Option<String>) -> Result<(), String> {
        if let Some(ref domain) = cloud_domain {
            if !is_domain_allowed(domain) {
                return Err(format!("domain not allowed: {domain}"));
            }
        }
        let mut guard = self.config.write().unwrap();
        guard.mode = mode;
        if mode == AppMode::Cloud {
            guard.cloud_domain = cloud_domain;
        }
        let _ = std::fs::create_dir_all(self.path.parent().unwrap());
        let _ = std::fs::write(&self.path, serde_json::to_string_pretty(&*guard).unwrap());
        Ok(())
    }

}

pub fn is_domain_allowed(domain: &str) -> bool {
    let d = domain.to_ascii_lowercase();
    let d = d.trim_end_matches('.');
    d == "ellul.ai"
        || d.ends_with(".ellul.ai")
        || d == "ellul.app"
        || d.ends_with(".ellul.app")
}
