use std::{env, path::{Path, PathBuf}};

fn watch_dir(dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                watch_dir(&path);
            } else {
                println!("cargo:rerun-if-changed={}", path.display());
            }
        }
    }
}

fn main() {
    // Frontend synchronization is handled once by tauri.conf.json's
    // beforeBuildCommand. Keeping it out of build.rs avoids duplicate builds
    // and makes `cargo check` independent of Node.
    watch_dir(Path::new("../js"));
    watch_dir(Path::new("../css"));
    watch_dir(Path::new("../foliate-js-main"));
    println!("cargo:rerun-if-changed=../index.html");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    println!("cargo:rustc-check-cfg=cfg(ll_mupdf)");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_INCLUDE");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_LIB_DIR");
    println!("cargo:rerun-if-env-changed=LL_MUPDF_LIBS");

    let include = env::var_os("LL_MUPDF_INCLUDE").map(PathBuf::from)
        .or_else(|| {
            let p = PathBuf::from("native/include");
            p.exists().then_some(p)
        });
    let lib_dir = env::var_os("LL_MUPDF_LIB_DIR").map(PathBuf::from)
        .or_else(|| {
            let p = PathBuf::from("native/lib");
            p.exists().then_some(p)
        });

    if let (Some(include), Some(lib_dir)) = (include, lib_dir) {
        println!("cargo:rerun-if-changed=native/ll_mupdf.c");
        println!("cargo:rerun-if-changed=native/ll_mupdf.h");
        cc::Build::new()
            .file("native/ll_mupdf.c")
            .include("native")
            .include(&include)
            .warnings(true)
            .compile("ll_mupdf_bridge");

        println!("cargo:rustc-link-search=native={}", lib_dir.display());
        let libs = env::var("LL_MUPDF_LIBS").unwrap_or_else(|_| "mupdf".into());
        for lib in libs.split(|c| c == ';' || c == ',').map(str::trim).filter(|x| !x.is_empty()) {
            println!("cargo:rustc-link-lib={lib}");
        }
        println!("cargo:rustc-cfg=ll_mupdf");
        println!("cargo:warning=MuPDF native backend enabled");
    } else {
        println!("cargo:warning=MuPDF native backend disabled; set LL_MUPDF_INCLUDE and LL_MUPDF_LIB_DIR to enable it");
    }

    tauri_build::build();
}
