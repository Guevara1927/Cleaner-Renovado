// Escaner de disco rapido y exacto.
// Usa NtQueryDirectoryFile (FileFullDirectoryInformation): cada entrada del directorio trae
// EndOfFile (tamano logico) y AllocationSize (espacio realmente ocupado en disco, con clusters,
// compresion, archivos dispersos y marcadores de nube), sin hacer una llamada por archivo.
//
// Uso:  diskscan.exe scan <directorio>
// Salida (UTF-8, campos separados por TAB):
//   F name logical disk            archivo directamente dentro del directorio
//   C name logical disk files      subcarpeta terminada (total recursivo)
//   P files logical disk denied current   progreso
//   X path                         carpeta sin acceso (muestra)
//   D files logical disk denied    fin
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class DiskScan
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr tmpl);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [StructLayout(LayoutKind.Sequential)] struct IOSB { public IntPtr Status; public IntPtr Info; }
    [DllImport("ntdll.dll")]
    static extern int NtQueryDirectoryFile(IntPtr h, IntPtr ev, IntPtr apc, IntPtr ctx, out IOSB iosb, IntPtr buf, uint len,
        int cls, [MarshalAs(UnmanagedType.U1)] bool single, IntPtr fileName, [MarshalAs(UnmanagedType.U1)] bool restart);

    const int BUF = 1 << 16;

    class Top { public string Name; public long L, D, Cnt; public int Pending; }
    class Job { public string Path; public Top Owner; }

    static StreamWriter outw;
    static readonly object olock = new object();
    static long gFiles, gLogical, gDisk, gDenied;
    static volatile string current = "";
    static readonly List<string> deniedSample = new List<string>();
    static BlockingCollection<Job> queue = new BlockingCollection<Job>();
    static long outstanding;

    static void Emit(string s) { lock (olock) { outw.WriteLine(s); } }
    static string Clean(string s) { return s.Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' '); }

    static bool ReadDir(string dir, out long l, out long d, out long cnt, List<string> subs, List<string[]> files)
    {
        l = 0; d = 0; cnt = 0;
        string p = dir.StartsWith(@"\\?\") ? dir : @"\\?\" + dir;
        IntPtr h = CreateFileW(p, 0x100001, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero);
        if (h == new IntPtr(-1)) return false;
        IntPtr buf = Marshal.AllocHGlobal(BUF);
        try
        {
            bool restart = true;
            while (true)
            {
                IOSB io;
                int st = NtQueryDirectoryFile(h, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out io, buf, (uint)BUF, 2, false, IntPtr.Zero, restart);
                restart = false;
                if (st != 0) break;
                int off = 0;
                while (true)
                {
                    int next = Marshal.ReadInt32(buf, off);
                    long eof = Marshal.ReadInt64(buf, off + 40);
                    long alloc = Marshal.ReadInt64(buf, off + 48);
                    int attr = Marshal.ReadInt32(buf, off + 56);
                    int nlen = Marshal.ReadInt32(buf, off + 60);
                    string name = Marshal.PtrToStringUni(IntPtr.Add(buf, off + 68), nlen / 2);
                    if (name != "." && name != "..")
                    {
                        if ((attr & 0x10) != 0)
                        {
                            if ((attr & 0x400) == 0) subs.Add(name); // ignorar junctions/symlinks de carpeta
                        }
                        else
                        {
                            l += eof; d += alloc; cnt++;
                            if (files != null) files.Add(new string[] { name, eof.ToString(), alloc.ToString() });
                        }
                    }
                    if (next == 0) break;
                    off += next;
                }
            }
        }
        finally { Marshal.FreeHGlobal(buf); CloseHandle(h); }
        return true;
    }

    static string Join(string dir, string name) { return dir.TrimEnd('\\') + "\\" + name; }

    static void Worker()
    {
        foreach (Job job in queue.GetConsumingEnumerable())
        {
            long l, d, cnt;
            var subs = new List<string>();
            current = job.Path;
            if (ReadDir(job.Path, out l, out d, out cnt, subs, null))
            {
                Interlocked.Add(ref job.Owner.L, l); Interlocked.Add(ref job.Owner.D, d); Interlocked.Add(ref job.Owner.Cnt, cnt);
                Interlocked.Add(ref gFiles, cnt); Interlocked.Add(ref gLogical, l); Interlocked.Add(ref gDisk, d);
                foreach (string s in subs)
                {
                    Interlocked.Increment(ref job.Owner.Pending);
                    Interlocked.Increment(ref outstanding);
                    queue.Add(new Job { Path = Join(job.Path, s), Owner = job.Owner });
                }
            }
            else
            {
                Interlocked.Increment(ref gDenied);
                lock (deniedSample) { if (deniedSample.Count < 40) deniedSample.Add(job.Path); }
            }
            if (Interlocked.Decrement(ref job.Owner.Pending) == 0)
                Emit("C\t" + Clean(job.Owner.Name) + "\t" + job.Owner.L + "\t" + job.Owner.D + "\t" + job.Owner.Cnt);
            if (Interlocked.Decrement(ref outstanding) == 0) queue.CompleteAdding();
        }
    }

    static int Main(string[] args)
    {
        outw = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        if (args.Length < 2) return 2;
        string root = args[1];
        long l0, d0, c0;
        var subs0 = new List<string>();
        var files0 = new List<string[]>();
        if (!ReadDir(root, out l0, out d0, out c0, subs0, files0))
        {
            Emit("X\t" + Clean(root)); Emit("D\t0\t0\t0\t1"); return 1;
        }
        foreach (var f in files0) Emit("F\t" + Clean(f[0]) + "\t" + f[1] + "\t" + f[2]);
        gFiles = c0; gLogical = l0; gDisk = d0;

        var tops = new List<Top>();
        foreach (string s in subs0) tops.Add(new Top { Name = s, Pending = 1 });
        outstanding = tops.Count;
        if (tops.Count == 0) queue.CompleteAdding();
        foreach (Top t in tops) queue.Add(new Job { Path = Join(root, t.Name), Owner = t });

        int n = Math.Max(8, Environment.ProcessorCount * 2);
        var threads = new List<Thread>();
        for (int i = 0; i < n; i++) { var th = new Thread(Worker); th.IsBackground = true; th.Start(); threads.Add(th); }

        var done = false;
        var prog = new Thread(() =>
        {
            while (!done)
            {
                Thread.Sleep(150);
                Emit("P\t" + Interlocked.Read(ref gFiles) + "\t" + Interlocked.Read(ref gLogical) + "\t" + Interlocked.Read(ref gDisk) + "\t" + Interlocked.Read(ref gDenied) + "\t" + Clean(current));
            }
        });
        prog.IsBackground = true; prog.Start();

        foreach (var th in threads) th.Join();
        done = true;
        lock (deniedSample) { foreach (string s in deniedSample) Emit("X\t" + Clean(s)); }
        Emit("D\t" + gFiles + "\t" + gLogical + "\t" + gDisk + "\t" + gDenied);
        return 0;
    }
}
