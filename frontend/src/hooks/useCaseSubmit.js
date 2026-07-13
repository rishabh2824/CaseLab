import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { apiFetch } from '../client.js'
import { normalizePersona, normalizeReferral } from '../pages/admin/Helpers.js'
import { slugify } from '../pages/student/Helpers.js'

// Owns the case-form's submit flow: client-side validation, file uploads to
// Spaces, building the exact CasePayload/PersonaPayload/ReferralPayload
// shape the backend accepts, and the create/update mutation itself. Split
// out of caseForm.jsx (which otherwise also owns form state, normalization,
// and the referral-tree rendering) so each concern is separately readable.
export function useCaseSubmit({ adminJwt, isEditMode, editCaseId }) {
    const [submitError, setSubmitError] = useState('')
    const [submitSuccess, setSubmitSuccess] = useState('')

    const saveMutation = useMutation({
        mutationFn: (payload) =>
            apiFetch(isEditMode ? `/api/cases/${editCaseId}` : '/api/cases', {
                method: isEditMode ? 'PUT' : 'POST',
                adminJwt,
                body: payload,
            }),
        onSuccess: () =>
            setSubmitSuccess(
                isEditMode ? 'Case updated successfully.' : 'Case saved successfully.',
            ),
        onError: (error) => {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        },
    })

    const submitCase = async ({
        caseName,
        initialBrief,
        commonInformation,
        simulationDurationMinutes,
        accessCode,
        totalPersonas,
        personas,
        simulationDurationError,
    }) => {
        if (typeof totalPersonas !== 'number' || totalPersonas < 1) {
            setSubmitError('Enter the number of AI personas that are not referred (at least 1).')
            setSubmitSuccess('')
            return
        }
        if (simulationDurationError) {
            setSubmitError(simulationDurationError)
            setSubmitSuccess('')
            return
        }
        setSubmitError('')
        setSubmitSuccess('')

        const buildPrefix = () => {
            const slug = slugify(caseName)
            return slug ? `cases/${slug}` : 'cases'
        }

        const uploadFile = async (file, prefix) => {
            const presign = await apiFetch('/api/uploads/presign', {
                method: 'POST',
                adminJwt,
                body: {
                    file_name: file.name,
                    content_type: file.type || null,
                    prefix,
                },
            })
            const putResponse = await fetch(presign.upload_url, {
                method: 'PUT',
                headers: {
                    'Content-Type': presign.content_type || 'application/octet-stream',
                },
                body: file,
            })
            if (!putResponse.ok) {
                throw new Error('Failed to upload file to Spaces.')
            }
            return {
                bucket: presign.bucket,
                object_key: presign.object_key,
                file_name: presign.file_name,
                content_type: presign.content_type,
            }
        }

        const normalizeFileEntry = async (entry, prefix) => {
            if (!entry?.file) {
                return { ...entry, file: null }
            }
            if (entry.file instanceof File) {
                const uploaded = await uploadFile(entry.file, prefix)
                return { ...entry, file: uploaded }
            }
            return { ...entry }
        }

        const normalizeProfilePhoto = async (profilePhoto, prefix) => {
            if (!profilePhoto) {
                return null
            }
            if (profilePhoto instanceof File) {
                return await uploadFile(profilePhoto, prefix)
            }
            return profilePhoto
        }

        // Builds exactly what CasePayload/PersonaPayload/ReferralPayload accept.
        // Deliberately NOT a `{...normalized, ...}` spread: `file_count`/
        // `referral_out_count` (persona-side UI counters) and `name` (the
        // referral's own display label) are client-form state the backend
        // ignores/recomputes from the real files/referrals arrays — listing
        // fields explicitly here is what keeps them from being sent at all.
        const buildPersonaPayload = async (persona, prefix) => {
            const normalized = normalizePersona(persona)
            const profile_photo = await normalizeProfilePhoto(normalized.profile_photo, prefix)
            const files = await Promise.all(
                (normalized.files ?? []).map((entry) => normalizeFileEntry(entry, prefix)),
            )
            const referrals = await Promise.all(
                (normalized.referrals ?? []).map(async (referral) => {
                    const normalizedReferral = normalizeReferral(referral)
                    return {
                        conditions: normalizedReferral.conditions,
                        persona: await buildPersonaPayload(normalizedReferral.persona, prefix),
                    }
                }),
            )
            return {
                name: normalized.name,
                role: normalized.role,
                profile_photo,
                known_facts: normalized.known_facts,
                personality_traits: normalized.personality_traits,
                availability_minutes: normalized.availability_minutes,
                files,
                referrals,
            }
        }

        try {
            const prefix = buildPrefix()
            const personasPayload = await Promise.all(
                personas.map((persona) => buildPersonaPayload(persona, prefix)),
            )
            const payload = {
                case_name: caseName.trim(),
                initial_brief: initialBrief.trim(),
                common_information: commonInformation.trim(),
                simulation_duration: simulationDurationMinutes,
                access_code: accessCode.trim(),
                total_non_referred_personas: totalPersonas,
                personas: personasPayload,
            }
            saveMutation.mutate(payload)
        } catch (error) {
            setSubmitError(error.message || 'Upload failed.')
            setSubmitSuccess('')
        }
    }

    return {
        submitError,
        submitSuccess,
        isSubmitting: saveMutation.isPending,
        submitCase,
    }
}
