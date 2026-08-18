import { useCallback, useRef, useState } from 'react';
import { Upload, FileSpreadsheet, Loader2, CheckCircle2, AlertCircle, GitBranch } from 'lucide-react';
import * as XLSX from 'xlsx';
import { supabase } from '@/lib/supabase';

type StatusType = 'idle' | 'working' | 'success' | 'error';

interface StatusState {
  type: StatusType;
  message: string;
}

const SHEET_PEOPLE = 'الأشخاص';
const SHEET_MARRIAGES = 'الزيجات';
const SHEET_CHILDREN = 'ربط_الأبناء';

const normalizeGender = (raw: string): string | null => {
  const v = (raw || '').trim();
  if (v === 'ذكر') return 'male';
  if (v === 'انثى' || v === 'أنثى') return 'female';
  return null;
};

const normalizeExternal = (raw: string): boolean => {
  const v = (raw || '').trim();
  return v === 'نعم' || v === 'true' || v === '1';
};

const normalizeLifeStatus = (raw: string): 'حي' | 'متوفى' | 'شهيد' | null => {
  const v = (raw || '').trim();
  if (v === 'حي' || v === 'متوفى' || v === 'شهيد') return v;
  return null;
};

const trimValue = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  return String(v).trim();
};

export default function Dashboard() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<StatusState>({ type: 'idle', message: 'في انتظار اختيار ملف Excel.' });
  const [fileName, setFileName] = useState<string>('');

  const updateStatus = (type: StatusType, message: string) => {
    setStatus({ type, message });
  };

  const handleFile = useCallback(async (file: File) => {
    setFileName(file.name);
    updateStatus('working', 'قراءة الملف…');

    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array' });

      // --- 1. Read "الأشخاص" sheet ---
      const peopleSheet = workbook.Sheets[SHEET_PEOPLE];
      if (!peopleSheet) {
        updateStatus('error', `الورقة "${SHEET_PEOPLE}" غير موجودة في الملف.`);
        return;
      }
      const peopleRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(peopleSheet, { defval: '' });

      const tempIdToUuid = new Map<string, string>();

      // First pass: assign UUIDs
      for (const row of peopleRows) {
        const tempId = trimValue(row['رقم_مؤقت']);
        if (tempId && !tempIdToUuid.has(tempId)) {
          tempIdToUuid.set(tempId, crypto.randomUUID());
        }
      }

      // Second pass: build people records
      const peopleToInsert = peopleRows
        .map((row) => {
          const tempId = trimValue(row['رقم_مؤقت']);
          const fullName = trimValue(row['الاسم الكامل']);
          const familyTitle = trimValue(row['اللقب/العشيرة']);
          const gender = normalizeGender(trimValue(row['الجنس']));
          const fatherTemp = trimValue(row['رقم_الأب_المؤقت']);
          const lifeStatus = normalizeLifeStatus(trimValue(row['الحالة']));
          const isExternal = normalizeExternal(trimValue(row['خارجي؟']));

          const fatherId = fatherTemp ? tempIdToUuid.get(fatherTemp) ?? null : null;
          const id = tempId ? tempIdToUuid.get(tempId) ?? null : null;

          return {
            id,
            display_id: tempId || null,
            full_name: fullName || null,
            family_title: familyTitle || null,
            gender,
            father_id: fatherId,
            is_external: isExternal,
            life_status: lifeStatus,
          };
        })
        .filter((p) => p.id !== null) as Array<{
          id: string;
          display_id: string | null;
          full_name: string | null;
          family_title: string | null;
          gender: string | null;
          father_id: string | null;
          is_external: boolean;
          life_status: 'حي' | 'متوفى' | 'شهيد' | null;
        }>;

      if (peopleToInsert.length === 0) {
        updateStatus('error', 'لا يوجد أشخاص صالحون للاستيراد في الورقة.');
        return;
      }

      // --- 2. INSERT people ---
      updateStatus('working', `رفع الأشخاص (${peopleToInsert.length})…`);
      const { error: peopleError } = await supabase.from('people').insert(peopleToInsert);
      if (peopleError) {
        updateStatus('error', `خطأ أثناء رفع الأشخاص: ${peopleError.message}`);
        return;
      }

      // --- 3. Read "الزيجات" sheet ---
      const marriagesSheet = workbook.Sheets[SHEET_MARRIAGES];
      if (!marriagesSheet) {
        updateStatus('error', `تم رفع الأشخاص، لكن الورقة "${SHEET_MARRIAGES}" غير موجودة.`);
        return;
      }
      const marriageRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(marriagesSheet, { defval: '' });

      const marriagesToInsert = marriageRows
        .map((row) => {
          const marriageId = trimValue(row['رقم_الزيجة']);
          const husbandTemp = trimValue(row['رقم_الزوج_المؤقت']);
          const wifeTemp = trimValue(row['رقم_الزوجة_المؤقت']);
          const note = trimValue(row['ملاحظة']);

          return {
            marriage_id: marriageId,
            husband_id: husbandTemp ? tempIdToUuid.get(husbandTemp) ?? null : null,
            wife_id: wifeTemp ? tempIdToUuid.get(wifeTemp) ?? null : null,
            status: note || null,
          };
        })
        .filter((m) => m.marriage_id) as Array<{
          marriage_id: string;
          husband_id: string | null;
          wife_id: string | null;
          status: string | null;
        }>;

      if (marriagesToInsert.length > 0) {
        updateStatus('working', `رفع الزيجات (${marriagesToInsert.length})…`);
        const { error: marriagesError } = await supabase.from('marriages').insert(marriagesToInsert);
        if (marriagesError) {
          updateStatus('error', `خطأ أثناء رفع الزيجات: ${marriagesError.message}`);
          return;
        }
      }

      // --- 4. Read "ربط_الأبناء" sheet ---
      const childrenSheet = workbook.Sheets[SHEET_CHILDREN];
      if (!childrenSheet) {
        updateStatus('error', `تم رفع الأشخاص والزيجات، لكن الورقة "${SHEET_CHILDREN}" غير موجودة.`);
        return;
      }
      const childrenRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(childrenSheet, { defval: '' });

      const childrenToInsert = childrenRows
        .map((row) => {
          const childTemp = trimValue(row['رقم_الابن_أو_الابنة_المؤقت']);
          const marriageId = trimValue(row['رقم_الزيجة']);
          return {
            child_id: childTemp ? tempIdToUuid.get(childTemp) ?? null : null,
            marriage_id: marriageId || null,
          };
        })
        .filter((c) => c.child_id && c.marriage_id) as Array<{
          child_id: string;
          marriage_id: string;
        }>;

      if (childrenToInsert.length > 0) {
        updateStatus('working', `رفع الروابط (${childrenToInsert.length})…`);
        const { error: childrenError } = await supabase.from('children_link').insert(childrenToInsert);
        if (childrenError) {
          updateStatus('error', `خطأ أثناء رفع الروابط: ${childrenError.message}`);
          return;
        }
      }

      // --- 5. Success ---
      const parts = [
        `${peopleToInsert.length} شخص`,
        marriagesToInsert.length > 0 ? `${marriagesToInsert.length} زيجة` : null,
        childrenToInsert.length > 0 ? `${childrenToInsert.length} رابط` : null,
      ].filter(Boolean);
      updateStatus('success', `نجاح. تم رفع: ${parts.join('، ')}.`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateStatus('error', `خطأ غير متوقع: ${msg}`);
    }
  }, []);

  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
    // reset so the same file can be selected again
    e.target.value = '';
  };

  const statusIcon = () => {
    switch (status.type) {
      case 'working':
        return <Loader2 className="w-5 h-5 animate-spin text-blue-600" />;
      case 'success':
        return <CheckCircle2 className="w-5 h-5 text-green-600" />;
      case 'error':
        return <AlertCircle className="w-5 h-5 text-red-600" />;
      default:
        return <FileSpreadsheet className="w-5 h-5 text-slate-400" />;
    }
  };

  const statusColor = () => {
    switch (status.type) {
      case 'working':
        return 'text-blue-700 bg-blue-50 border-blue-200';
      case 'success':
        return 'text-green-700 bg-green-50 border-green-200';
      case 'error':
        return 'text-red-700 bg-red-50 border-red-200';
      default:
        return 'text-slate-600 bg-slate-50 border-slate-200';
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-slate-100 flex flex-col items-center py-12 px-4 font-sans">
      <div className="w-full max-w-xl">
        <header className="mb-8 text-center">
          <h1 className="text-2xl font-bold text-slate-800">لوحة تحكم الاستيراد</h1>
          <p className="mt-2 text-sm text-slate-500">ارفع ملف Excel لاستيراد الأشخاص والزيجات وروابط الأبناء.</p>
        </header>

        <div className="bg-white rounded-xl shadow-sm border border-slate-200 p-6">
          <button
            onClick={() => inputRef.current?.click()}
            disabled={status.type === 'working'}
            className="w-full flex flex-col items-center justify-center gap-3 py-10 border-2 border-dashed border-slate-300 rounded-lg transition-colors hover:border-blue-400 hover:bg-blue-50/50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Upload className="w-8 h-8 text-slate-400" />
            <span className="text-sm font-medium text-slate-600">اختر ملف Excel</span>
            <span className="text-xs text-slate-400">.xlsx أو .xls</span>
          </button>

          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={onInputChange}
            className="hidden"
          />

          {fileName && (
            <p className="mt-4 text-xs text-slate-500 text-center">
              الملف: <span className="font-medium text-slate-700">{fileName}</span>
            </p>
          )}

          <div className={`mt-4 flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${statusColor()}`}>
            <span className="mt-0.5 shrink-0">{statusIcon()}</span>
            <span className="leading-relaxed whitespace-pre-wrap break-words">{status.message}</span>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-4">
          <span className="text-xs text-slate-400">الأوراق: «الأشخاص»، «الزيجات»، «ربط_الأبناء»</span>
          <a href="#/tree" className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 font-medium">
            <GitBranch className="w-3.5 h-3.5" />
            عرض شجرة العائلة
          </a>
        </div>
      </div>
    </div>
  );
}
