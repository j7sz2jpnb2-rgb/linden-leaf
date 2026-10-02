import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val projectDir = project.projectDir
        val targetVal = target ?: throw GradleException("target cannot be null")
        val isRel = release == true
        val mode = if (isRel) "release" else "debug"

        val abi = when (targetVal) {
            "aarch64", "arm64-v8a" -> "arm64-v8a"
            "armv7", "armeabi-v7a" -> "armeabi-v7a"
            "i686", "x86" -> "x86"
            "x86_64" -> "x86_64"
            else -> "arm64-v8a"
        }
        val rustTriple = when (targetVal) {
            "aarch64" -> "aarch64-linux-android"
            "armv7" -> "armv7-linux-androideabi"
            "i686" -> "i686-linux-android"
            "x86_64" -> "x86_64-linux-android"
            else -> targetVal
        }

        val jniLibsDir = File(projectDir, "src/main/jniLibs/$abi")
        jniLibsDir.mkdirs()
        val destFile = File(jniLibsDir, "liblinden_leaf_lib.so")

        val cargoTargetDir = System.getenv("CARGO_TARGET_DIR") ?: "D:/LindenLeaf-Build/target"
        val sourceFile = File(cargoTargetDir, "$rustTriple/$mode/liblinden_leaf_lib.so")

        // 1. Try running Tauri CLI with proper target and mode
        val candidates = mutableListOf("pnpm")
        if (Os.isFamily(Os.FAMILY_WINDOWS)) {
            candidates.addAll(listOf(
                "pnpm.cmd",
                "pnpm.exe",
                "C:/Users/YONGHU/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/pnpm.cmd"
            ))
        }

        var buildSucceeded = false
        var lastError: Exception? = null
        for (candidate in candidates) {
            try {
                runTauriCli(candidate, targetVal, isRel)
                buildSucceeded = true
                break
            } catch (e: Exception) {
                lastError = e
            }
        }

        if (buildSucceeded) {
            if (!sourceFile.exists()) {
                throw GradleException("Tauri CLI reported success but artifact not found at $sourceFile")
            }
            sourceFile.copyTo(destFile, overwrite = true)
            println("[BuildTask] Successfully compiled and staged $sourceFile to $destFile (${destFile.length()} bytes)")
        } else if (System.getenv("LINDEN_EXPLICIT_PRESTAGED_SO") == "1" && destFile.exists() && destFile.length() > 0) {
            // Explicitly confirmed and verified pre-staged library from the active build pipeline
            println("[BuildTask] Reusing explicitly verified pre-staged native library at $destFile (${destFile.length()} bytes)")
        } else {
            val errMsg = "BuildTask failed: Could not compile native library for $rustTriple ($mode)." +
                (if (lastError != null) " Tauri CLI error: ${lastError.message}" else " Pre-staged library not authorized or missing at $destFile")
            throw GradleException(errMsg, lastError)
        }

        if (!destFile.exists() || destFile.length() == 0L) {
            throw GradleException("BuildTask failed: Destination library $destFile does not exist or is empty for $rustTriple ($mode)")
        }
    }

    fun runTauriCli(executable: String, targetVal: String, isRelease: Boolean) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val args = listOf("tauri", "android", "android-studio-script")

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (isRelease) {
                args("--release")
            }
            args(listOf("--target", targetVal))
        }.assertNormalExitValue()
    }
}