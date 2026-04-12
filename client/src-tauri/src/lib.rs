use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;
use tauri::{Manager, RunEvent};
use std::sync::Mutex;

#[tauri::command]
async fn run_ollama_serve(app: tauri::AppHandle) -> Result<(), String> {
    let shell = app.shell();
    shell.command("ollama")
        .args(["serve"])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![run_ollama_serve])
        .setup(|app| {
            let sidecar_command = app.shell().sidecar("loom-backend").unwrap();
            let (_, child) = sidecar_command.spawn().expect("Failed to spawn sidecar");
            app.manage(Mutex::new(Some(child)));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| match event {
            RunEvent::Exit => {
                if let Some(state) = app_handle.try_state::<Mutex<Option<CommandChild>>>() {
                    if let Ok(mut lock) = state.lock() {
                        if let Some(child) = lock.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
            _ => {}
        });
}
