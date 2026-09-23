package com.noteproject.study408;

import org.junit.Test;
import static org.junit.Assert.*;

public class BackupRepositoryRootPolicyTest {
    @Test public void acceptsOnlyMatchingRootOrCommonParent() {
        assertTrue(BackupRepositoryRootPolicy.matches("study-journal-backup-A", "study-journal-backup-A", true, true));
        assertFalse(BackupRepositoryRootPolicy.matches("parent", "study-journal-backup-A", true, false));
        assertFalse(BackupRepositoryRootPolicy.matches("parent", "study-journal-backup-B", true, false));
    }
    @Test public void rejectsOtherAndLegacyRepositoryRoots() {
        for (String root : new String[] { "study-journal-backup-A", "study-journal-backup", "renamed" }) {
            try { BackupRepositoryRootPolicy.matches(root, "study-journal-backup-B", true, true); fail("foreign root accepted"); }
            catch (IllegalStateException expected) { assertTrue(expected.getMessage().contains("父文件夹")); }
        }
        assertTrue(BackupRepositoryRootPolicy.matches("study-journal-backup", "study-journal-backup", true, true));
    }
}
