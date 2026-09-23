package com.noteproject.study408;

final class BackupRepositoryRootPolicy {
    static boolean matches(String displayName, String repositoryName, boolean directory, boolean hasManifestAndSnapshots) {
        if (directory && repositoryName.equals(displayName)) return true;
        if (hasManifestAndSnapshots) throw new IllegalStateException("所选文件夹已经是其他自动备份仓库，请选择其父文件夹或当前目的地文件夹。");
        return false;
    }
}
