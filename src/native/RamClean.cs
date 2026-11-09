// Liberacion segura de RAM.
//  1) EmptyWorkingSet en cada proceso accesible (salvo el de la ventana en primer plano, Sistema y esta app):
//     el SO recorta las paginas que el proceso no esta usando; se recuperan solas si el programa las necesita.
//  2) Con privilegios de administrador: escribe a disco las paginas modificadas y vacia la lista de espera (standby).
// Uso: ramclean.exe [pid_a_omitir ...]
// Salida (TAB): T trimmed failed | N ntstatus_privilegio | S status_flush status_standby
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

static class RamClean
{
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("psapi.dll")] static extern bool EmptyWorkingSet(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("ntdll.dll")] static extern int RtlAdjustPrivilege(int priv, bool enable, bool currentThread, out bool old);
    [DllImport("ntdll.dll")] static extern int NtSetSystemInformation(int cls, ref int info, int len);

    static int Main(string[] args)
    {
        var skip = new HashSet<int>();
        foreach (string a in args) { int v; if (int.TryParse(a, out v)) skip.Add(v); }
        uint fg = 0;
        IntPtr fw = GetForegroundWindow();
        if (fw != IntPtr.Zero) GetWindowThreadProcessId(fw, out fg);
        int self = Process.GetCurrentProcess().Id;

        int ok = 0, fail = 0;
        foreach (Process p in Process.GetProcesses())
        {
            int id = p.Id;
            p.Dispose();
            if (id <= 4 || id == self || id == (int)fg || skip.Contains(id)) continue;
            IntPtr h = OpenProcess(0x0500, false, id); // QUERY_INFORMATION | SET_QUOTA
            if (h == IntPtr.Zero) { fail++; continue; }
            if (EmptyWorkingSet(h)) ok++; else fail++;
            CloseHandle(h);
        }
        Console.WriteLine("T\t" + ok + "\t" + fail);

        bool old;
        int pr = RtlAdjustPrivilege(13, true, false, out old); // SeProfileSingleProcessPrivilege
        if (pr == 0)
        {
            int cmd = 4; // MemoryPurgeStandbyList
            int st = NtSetSystemInformation(80, ref cmd, 4); // SystemMemoryListInformation
            Console.WriteLine("S\t" + st);
        }
        else Console.WriteLine("N\t" + pr);
        return 0;
    }
}
