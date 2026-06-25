import type { LeadingSectorRow } from '@/lib/types'

interface LeadingSectorsProps {
  marketLabel: string
  sectors: LeadingSectorRow[]
}

export function LeadingSectors({ marketLabel, sectors }: LeadingSectorsProps) {
  if (sectors.length === 0) {
    return <p className="text-sm text-gray-500">{marketLabel} 주도섹터 데이터가 없습니다.</p>
  }

  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700">{marketLabel} 주도섹터</h3>
      <ol className="mt-1 flex gap-2">
        {sectors
          .slice()
          .sort((a, b) => a.rank - b.rank)
          .map((sector) => (
            <li key={sector.sector} className="rounded-full bg-blue-100 px-3 py-1 text-sm text-blue-800">
              {sector.rank}. {sector.sector}
            </li>
          ))}
      </ol>
    </div>
  )
}
