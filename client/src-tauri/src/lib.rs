use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;
use tauri::{Manager, RunEvent};
use std::sync::Mutex;

/// Managed state wrapper for the Python sidecar child process.
struct SidecarState(Mutex<Option<CommandChild>>);

/// Managed state wrapper for the `ollama serve` child process.
/// Stored separately so the Ollama process can be killed independently
/// of the Python sidecar on exit — previously this handle was dropped
/// immediately after `spawn()`, causing an orphaned `ollama` process on
/// every application close (H-9).
struct OllamaState(Mutex<Option<CommandChild>>);

#[tauri::command]
async fn run_ollama_serve(app: tauri::AppHandle) -> Result<(), String> {
    let shell = app.shell();
    let (_, child) = shell
        .command("ollama")
        .args(["serve"])
        .spawn()
        .map_err(|e| e.to_string())?;

    // Store the child handle so we can kill it cleanly on exit.
    if let Some(state) = app.try_state::<OllamaState>() {
        if let Ok(mut lock) = state.0.lock() {
            // If there was a previous ollama process, kill it first.
            if let Some(old) = lock.take() {
                let _ = old.kill();
            }
            *lock = Some(child);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_ollama_serve])
        .setup(|app| {
            // Register OllamaState early so run_ollama_serve can store its handle.
            app.manage(OllamaState(Mutex::new(None)));

            let sidecar_command = app.shell().sidecar("loom-backend").unwrap();
            let (_, child) = sidecar_command.spawn().expect("Failed to spawn sidecar");
            app.manage(SidecarState(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::Exit => {
                // Kill the Python sidecar
                if let Some(state) = app_handle.try_state::<SidecarState>() {
                    if let Ok(mut lock) = state.0.lock() {
                        if let Some(child) = lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
                // Kill the ollama serve process (previously leaked on exit)
                if let Some(state) = app_handle.try_state::<OllamaState>() {
                    if let Ok(mut lock) = state.0.lock() {
                        if let Some(child) = lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
            _ => {}
        });
}
