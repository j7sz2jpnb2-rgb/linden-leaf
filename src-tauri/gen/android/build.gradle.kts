buildscript {
    val useCnMirror = System.getenv("USE_CN_MIRROR") == "true" ||
        project.findProperty("useCnMirror")?.toString() == "true"
    repositories {
        if (useCnMirror) {
            maven { url = uri("https://maven.aliyun.com/repository/google") }
            maven { url = uri("https://maven.aliyun.com/repository/public") }
            maven { url = uri("https://maven.aliyun.com/repository/central") }
        }
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    val useCnMirror = System.getenv("USE_CN_MIRROR") == "true" ||
        project.findProperty("useCnMirror")?.toString() == "true"
    repositories {
        if (useCnMirror) {
            maven { url = uri("https://maven.aliyun.com/repository/google") }
            maven { url = uri("https://maven.aliyun.com/repository/public") }
            maven { url = uri("https://maven.aliyun.com/repository/central") }
        }
        google()
        mavenCentral()
    }
}

tasks.register("clean").configure {
    delete("build")
}
