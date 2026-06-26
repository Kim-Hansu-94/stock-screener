import type { LeadingSectorRow } from '@/lib/types'
import { translateSector } from '@/lib/sectorMap'

interface LeadingSectorsProps {
  marketLabel: string
  sectors: LeadingSectorRow[]
}

export function LeadingSectors({ marketLabel, sectors }: LeadingSectorsProps) {
  if (sectors.length === 0) {
    return <p className="text-xs text-gray-400">{marketLabel} 주도섹터 데이터가 없습니다.</p>
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-400">주도섹터</span>
      {sectors
        .slice()
        .sort((a, b) => a.rank - b.rank)
        .map((sector) => (
          <span
            key={sector.sector}
            className="inline-flex items-center rounded-md bg-blue-50 px-2.5 py-0.5 text-xs font-medium text-blue-700"
          >
            {sector.rank}. {translateSector(sector.sector)}
          </span>
        ))}
    </div>
  )
}
